import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { HeartbeatSourceResult } from "@compozy/extension-sdk";

import { redactor } from "../src/items.ts";
import { regionEndpoints } from "../src/nerdgraph.ts";
import { logsNrql, logsSource, parseLogsParams } from "../src/sources/logs.ts";
import { ACCOUNT, assertRowOrderInvariant, catchSync, FAKE_KEY, fakeClient, pollRequest, rejection } from "./helpers.ts";

const BASE = { account_id: ACCOUNT, where: "level = 'error'", facet: "service.name", window: "15m", threshold: 50 };

const row = (service: string, count: number) => ({ facet: service, "service.name": service, count });

async function poll(
  rows: Record<string, unknown>[],
  raw: Record<string, unknown> = BASE,
  state: unknown = { v: 1, fp: parseLogsParams(raw).fingerprint, active: [] }
): Promise<HeartbeatSourceResult> {
  const params = parseLogsParams(raw);
  return await logsSource.poll(pollRequest(raw, state), params, {
    client: fakeClient(() => rows),
    endpoints: regionEndpoints(params.region),
    redact: redactor(FAKE_KEY),
    signal: new AbortController().signal,
  });
}

describe("newrelic/logs", () => {
  test("UT-060 logs: threshold 50 treats 50 as inactive and 51 as active", async () => {
    const result = await poll([row("auth", 50), row("payments", 51)]);
    assert.deepEqual(result.items.map(item => item.key), ["payments"]);
    assert.equal(result.items[0]?.title, "payments: 51 log lines in 15m (threshold 50)");
  });

  test("UT-060 logs: the item carries the count, facet and window (US-004 AC-1)", async () => {
    const result = await poll([row("payments", 120)]);
    assert.deepEqual(result.items[0], {
      key: "payments",
      title: "payments: 120 log lines in 15m (threshold 50)",
      summary: `Log spike · account ${ACCOUNT} (us) · 120 log lines in 15m (threshold 50) · service.name: payments · checked 2026-11-14T12:00:00.000Z`,
      url: "https://one.newrelic.com",
      attributes: {
        kind: "logs",
        account_id: ACCOUNT,
        region: "us",
        facet: "service.name",
        group: "payments",
        count: 120,
        window: "15m",
        threshold: 50,
        where: "level = 'error'",
      },
    });
  });

  test("UT-061 logs: no facet gives the single key all and no FACET clause", async () => {
    const raw = { account_id: ACCOUNT, where: "level = 'error'", threshold: 5 };
    assert.equal(logsNrql(parseLogsParams(raw)), "SELECT count(*) FROM Log WHERE level = 'error' SINCE 15 minutes ago LIMIT 501");
    const result = await poll([{ count: 9 }], raw);
    assert.deepEqual(result.items.map(item => [item.key, item.title]), [["all", "all logs: 9 log lines in 15m (threshold 5)"]]);
    // A missing facet attribute returns no rows: nothing breaches (US-004 EC-2).
    assert.deepEqual((await poll([])).items, []);
    assert.equal(catchSync(() => parseLogsParams({ account_id: ACCOUNT, threshold: 5 })).data?.code, "source_params_invalid");
    assert.equal(catchSync(() => parseLogsParams({ ...BASE, threshold: -1 })).data?.code, "source_params_invalid");
  });

  test("UT-062 logs: items contain no message field and no raw line content", async () => {
    const result = await poll([
      { facet: "payments", "service.name": "payments", count: 120, message: "card 4111 1111 declined", "latest.message": "raw line" },
    ]);
    const item = result.items[0]!;
    assert.equal("message" in (item.attributes as object), false);
    const text = JSON.stringify(item);
    assert.equal(text.includes("4111"), false);
    assert.equal(text.includes("raw line"), false);
  });

  test("UT-071 logs: an API key in a facet value or where never appears in the item", async () => {
    const raw = { ...BASE, where: `message LIKE '%${FAKE_KEY}%'` };
    const result = await poll([row(`svc-${FAKE_KEY}`, 99)], raw);
    assert.equal(result.items.length, 1);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });

  test("UT-031b logs: 501 rows fail with the narrow message; 500 rows are accepted", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`svc-${i}`, 51));
    const error = await rejection(poll(rows(501)));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, "logs returned more than 500 rows; narrow with.where or with.facet");
    assert.equal((await poll(rows(500))).items.length, 20); // max_items; the rest stay pending
  });

  test("UT-121 determinism: shuffled NerdGraph row order gives an identical logs result", async () => {
    const rows = [row("payments", 120), row("auth", 70), row("search", 10), row("cart", 70), row("auth", 90)];
    const result = await assertRowOrderInvariant(rows, ordered => poll(ordered));
    assert.deepEqual(result.items.map(item => item.key), ["payments", "auth", "cart"]);
  });

  test("UT-071 logs: an API key in the facet parameter never appears in the item (review R-6)", async () => {
    const raw = { ...BASE, facet: `svc.${FAKE_KEY}` };
    const result = await poll([{ facet: "payments", count: 120 }], raw);
    assert.equal(result.items.length, 1);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });

  test("IT-003b logs: a row without a numeric count is an unexpected response, not a params error (review R-3)", async () => {
    for (const bad of [{ facet: "payments" }, { facet: "payments", count: "12" }]) {
      const error = await rejection(poll([bad]));
      assert.equal(error.data?.code, "source_extension_failed");
      assert.equal(error.message, "New Relic request failed: unexpected response");
    }
  });
});
