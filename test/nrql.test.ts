import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { HeartbeatSourceResult } from "@compozy/extension-sdk";

import { redactor } from "../src/items.ts";
import { regionEndpoints } from "../src/nerdgraph.ts";
import { KEY_PATTERN } from "../src/normalize.ts";
import { nrqlSource, parseNrqlParams } from "../src/sources/nrql.ts";
import {
  ACCOUNT,
  assertRowOrderInvariant,
  catchSync,
  FAKE_KEY,
  fakeClient,
  pollRequest,
  rejection,
} from "./helpers.ts";

const NRQL =
  "SELECT percentile(duration, 95) FROM Transaction WHERE appName = 'checkout-api' FACET appName SINCE 15 minutes ago";
const BASE = { account_id: ACCOUNT, nrql: NRQL, threshold: 1.5 };

async function poll(
  rows: Record<string, unknown>[],
  state: unknown = { v: 1, fp: parseNrqlParams(BASE).fingerprint, active: [] },
  raw: Record<string, unknown> = BASE
): Promise<HeartbeatSourceResult> {
  const params = parseNrqlParams(raw);
  return await nrqlSource.poll(pollRequest(raw, state), params, {
    client: fakeClient(() => rows),
    endpoints: regionEndpoints(params.region),
    redact: redactor(FAKE_KEY),
    signal: new AbortController().signal,
  });
}

const keysOf = (result: HeartbeatSourceResult) => result.items.map(item => item.key);
const p95 = (facet: unknown, value: number | null) => ({ facet, appName: facet, "percentile.duration": { "95": value } });

describe("newrelic/nrql", () => {
  test("UT-014 nrql: below 100 treats 80 as active and 120 as inactive", async () => {
    const raw = { account_id: ACCOUNT, nrql: "SELECT rate(count(*), 1 minute) FROM Transaction FACET appName", condition: "below", threshold: 100 };
    const state = { v: 1, fp: parseNrqlParams(raw).fingerprint, active: [] };
    const rows = [{ facet: "low", throughput: 80 }, { facet: "high", throughput: 120 }];
    const result = await poll(rows, state, raw);
    assert.deepEqual(keysOf(result), ["low"]);
    assert.equal(result.items[0]?.title, `low below 100: 80 (throughput, account ${ACCOUNT})`);
  });

  test("UT-017 nrql: notify_existing and default spelling keep the fingerprint; other params change it", () => {
    const fp = parseNrqlParams(BASE).fingerprint;
    assert.equal(parseNrqlParams({ ...BASE, notify_existing: true }).fingerprint, fp);
    assert.equal(parseNrqlParams({ ...BASE, condition: "above", region: "us" }).fingerprint, fp);
    for (const change of [{ threshold: 2 }, { condition: "below" }, { region: "eu" }, { account_id: 7 }, { nrql: "SELECT 1" }]) {
      assert.notEqual(parseNrqlParams({ ...BASE, ...change }).fingerprint, fp);
    }
  });

  test("UT-030 nrql: rows without a numeric non-facet field fail with the shape message", async () => {
    const error = await rejection(poll([{ facet: "a", appName: "a", name: "WebTransaction/x" }]));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, "nrql must return one number per row (e.g. SELECT count(*) ... FACET x)");
  });

  test("UT-031 nrql: 501 rows fail with the LIMIT message; 500 rows are accepted", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ facet: `app-${i}`, count: 1 }));
    const error = await rejection(poll(rows(501)));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, "nrql returned more than 500 rows; add LIMIT or narrow the FACET");
    const ok = await poll(rows(500), null);
    assert.equal((ok.state as { active: string[] }).active.length, 0);
  });

  test("UT-032 nrql: a null value is inactive", async () => {
    const result = await poll([p95("checkout-api", null), { facet: "cart", average: null }]);
    assert.deepEqual(result.items, []);
    assert.deepEqual((result.state as { active: string[] }).active, []);
  });

  test("UT-033 nrql: facet arrays join with / and no facet gives the fixed key", async () => {
    const faceted = await poll([{ facet: ["checkout-api", "prod"], appName: "checkout-api", count: 9 }]);
    assert.deepEqual(keysOf(faceted), ["checkout-api/prod"]);
    const single = await poll([{ "percentile.duration": { "95": 2.31 } }]);
    assert.deepEqual(keysOf(single), ["all"]); // Deviation D-2: the daemon rejects "_"
    assert.equal(single.items[0]?.title, `p95 duration above 1.5: 2.31 (account ${ACCOUNT})`);
  });

  test("UT-033 nrql: the item names facet, value, field and account (US-001 AC-1)", async () => {
    const result = await poll([p95("checkout-api", 2.31)]);
    assert.deepEqual(result.items[0], {
      key: "checkout-api",
      title: `checkout-api above 1.5: 2.31 (p95 duration, account ${ACCOUNT})`,
      summary: `NRQL threshold breach · account ${ACCOUNT} (us) · p95 duration above 1.5: 2.31 · facet: checkout-api · checked 2026-11-14T12:00:00.000Z`,
      url: "https://one.newrelic.com",
      attributes: {
        kind: "nrql",
        account_id: ACCOUNT,
        region: "us",
        condition: "above",
        threshold: 1.5,
        value: 2.31,
        field: "p95 duration",
        facet: "checkout-api",
        nrql: NRQL,
      },
    });
  });

  test("UT-070 items: title, summary, attributes and keys stay within daemon bounds", async () => {
    const huge = "x".repeat(3000);
    const nrql = `SELECT count(*) FROM Transaction WHERE name = '${"n".repeat(3900)}' FACET name`;
    const raw = { ...BASE, nrql };
    const state = { v: 1, fp: parseNrqlParams(raw).fingerprint, active: [] };
    const result = await poll([{ facet: [huge, "é".repeat(600)], count: 9 }], state, raw);
    const item = result.items[0]!;
    assert.ok(Array.from(item.title).length <= 200);
    assert.ok(Buffer.byteLength(item.summary ?? "") <= 1024);
    const attributes = item.attributes as Record<string, unknown>;
    assert.ok(Buffer.byteLength(JSON.stringify(attributes)) <= 2048);
    assert.equal("nrql" in attributes, false, "nrql is dropped first");
    assert.equal(attributes.value, 9);
    assert.ok(KEY_PATTERN.test(item.key) && Buffer.byteLength(item.key) <= 200);
    assert.match(item.key, /^x{180}#[0-9a-f]{12}$/);
    // A key that is valid as-is is kept; a lossy one gets the hash suffix.
    const lossy = await poll([{ facet: "checkout_api prod", count: 9 }, { facet: "_private", count: 8 }]);
    assert.deepEqual(
      lossy.items.map(entry => entry.key.replace(/#[0-9a-f]{8}$/, "#h")),
      ["checkout_api-prod#h", "x_private#h"]
    );
  });

  test("UT-071 items: an API key inside facet values or NRQL never appears in the item", async () => {
    const raw = { ...BASE, nrql: `SELECT count(*) FROM Log WHERE message LIKE '%${FAKE_KEY}%' FACET appName` };
    const state = { v: 1, fp: parseNrqlParams(raw).fingerprint, active: [] };
    const result = await poll([{ facet: `leak-${FAKE_KEY}-x`, [`count.${FAKE_KEY}`]: 5 }], state, raw);
    assert.equal(result.items.length, 1);
    const text = JSON.stringify(result);
    assert.equal(text.includes(FAKE_KEY), false);
    assert.ok(text.includes("[redacted]"));
  });

  test("UT-120 determinism: the same request twice gives deep-equal and byte-equal results", async () => {
    const rows = [p95("checkout-api", 2.31), p95("cart", 1.7), p95("search", 0.4)];
    const first = await poll(rows);
    const second = await poll(rows);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });

  test("UT-121 determinism: shuffled NerdGraph row order gives an identical nrql result", async () => {
    const rows = [
      p95("checkout-api", 2.31),
      p95("cart", 1.7),
      p95("search", 0.4),
      p95("pay", 1.7),
      p95("cart", 1.9), // duplicate key: the largest breach wins regardless of order
      p95("auth", null),
    ];
    const result = await assertRowOrderInvariant(rows, ordered => poll(ordered));
    assert.deepEqual(keysOf(result), ["checkout-api", "cart", "pay"]);
  });

  test("UT-080 nrql: params are validated before any credential or network use", () => {
    const error = catchSync(() => parseNrqlParams({ nrql: "SELECT 1", threshold: 1 }));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.throws(() => parseNrqlParams({ ...BASE, region: "loopback:70000" }), /region must be us or eu/);
    assert.equal(parseNrqlParams({ ...BASE, region: "loopback:8788" }).region, "loopback:8788");
  });
});
