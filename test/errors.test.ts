import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { HeartbeatSourceResult } from "@compozy/extension-sdk";

import { redactor } from "../src/items.ts";
import { regionEndpoints } from "../src/nerdgraph.ts";
import { KEY_PATTERN, normalizeMessage, sha256Hex } from "../src/normalize.ts";
import { errorsNrql, errorsSource, parseErrorsParams } from "../src/sources/errors.ts";
import { ACCOUNT, assertRowOrderInvariant, catchSync, FAKE_KEY, fakeClient, pollRequest, rejection } from "./helpers.ts";

const BASE = { account_id: ACCOUNT, where: "appName = 'checkout-api'", window: "30m", min_count: 10 };

const row = (app: string, errorClass: string, message: string, count: number) => ({
  facet: [app, errorClass, message],
  appName: app,
  "error.class": errorClass,
  "error.message": message,
  count,
});

async function poll(
  rows: Record<string, unknown>[],
  raw: Record<string, unknown> = BASE,
  state: unknown = { v: 1, fp: parseErrorsParams(raw).fingerprint, active: [] }
): Promise<HeartbeatSourceResult & { nrql: string[] }> {
  const params = parseErrorsParams(raw);
  const client = fakeClient(() => rows);
  const result = await errorsSource.poll(pollRequest(raw, state), params, {
    client,
    endpoints: regionEndpoints(params.region),
    redact: redactor(FAKE_KEY),
    signal: new AbortController().signal,
  });
  return { ...result, nrql: client.calls };
}

const hash8 = (message: string) => sha256Hex(message).slice(0, 8);

describe("newrelic/errors", () => {
  test("UT-050 errors: Order 123 and Order 456 not found are one type with summed counts", async () => {
    const result = await poll([
      row("checkout-api", "NotFoundError", "Order 123 not found", 6),
      row("checkout-api", "NotFoundError", "Order 456 not found", 5),
    ]);
    assert.equal(result.items.length, 1);
    const item = result.items[0]!;
    assert.equal(item.key, `checkout-api/NotFoundError/${hash8("Order # not found")}`);
    assert.equal(item.title, "NotFoundError in checkout-api: 11 in 30m");
    assert.deepEqual(item.attributes, {
      kind: "errors",
      account_id: ACCOUNT,
      region: "us",
      app: "checkout-api",
      class: "NotFoundError",
      message: "Order # not found",
      count: 11,
      window: "30m",
      min_count: 10,
    });
    assert.equal(item.url, "https://one.newrelic.com/errors-inbox");
    assert.equal(
      item.summary,
      `New error type · account ${ACCOUNT} (us) · 11 in 30m (min 10) · checked 2026-11-14T12:00:00.000Z · message: Order # not found`
    );
  });

  test("UT-051 errors: UUIDs, long hex and quoted strings collapse to # and messages stay within 160 characters", async () => {
    assert.equal(
      normalizeMessage(`Upstream "payments" timed out for 3f2b1c4d-0000-4a4a-9b9b-1234567890ab trace 0deadbeefcafe`),
      "Upstream # timed out for # trace #"
    );
    const long = `Failure ${"word ".repeat(100)}`;
    const result = await poll([row("checkout-api", "Boom", long, 12)]);
    const message = (result.items[0]!.attributes as { message: string }).message;
    assert.equal(Array.from(message).length, 160);
    assert.ok((result.items[0]!.summary ?? "").endsWith(message));
  });

  test("UT-052 errors: min_count 10 treats 9 as inactive and 10 as active", async () => {
    const result = await poll([row("checkout-api", "Nine", "nine", 9), row("checkout-api", "Ten", "ten", 10)]);
    assert.deepEqual(result.items.map(item => (item.attributes as { class: string }).class), ["Ten"]);
    // Default min_count 1: any type in the window is active (US-003 EC-1).
    const anyType = await poll([row("checkout-api", "Once", "once", 1)], { account_id: ACCOUNT });
    assert.equal(anyType.items.length, 1);
  });

  test("UT-053 errors: event_types appear in the FROM clause; the default is TransactionError", async () => {
    const both = parseErrorsParams({ ...BASE, event_types: ["TransactionError", "JavaScriptError"] });
    assert.equal(
      errorsNrql(both),
      "SELECT count(*) FROM JavaScriptError, TransactionError WHERE appName = 'checkout-api' FACET appName, error.class, error.message SINCE 30 minutes ago LIMIT 501"
    );
    assert.equal(
      errorsNrql(parseErrorsParams({ account_id: ACCOUNT })),
      "SELECT count(*) FROM TransactionError FACET appName, error.class, error.message SINCE 30 minutes ago LIMIT 501"
    );
    assert.equal(catchSync(() => parseErrorsParams({ ...BASE, event_types: ["Log"] })).data?.code, "source_params_invalid");
    assert.equal(catchSync(() => parseErrorsParams({ ...BASE, window: "2m" })).data?.code, "source_params_invalid");
    assert.equal(catchSync(() => parseErrorsParams({ ...BASE, min_count: 0 })).data?.code, "source_params_invalid");
    // Equivalent spellings share a fingerprint; notify_existing never enters it.
    assert.equal(parseErrorsParams({ ...BASE, window: "60m" }).fingerprint, parseErrorsParams({ ...BASE, window: "1h" }).fingerprint);
    assert.equal(parseErrorsParams({ ...BASE, notify_existing: true }).fingerprint, parseErrorsParams(BASE).fingerprint);
    assert.notEqual(parseErrorsParams({ ...BASE, min_count: 11 }).fingerprint, parseErrorsParams(BASE).fingerprint);
  });

  test("UT-054 errors: the key is app/class/<8 hex> sanitized to the daemon alphabet", async () => {
    const result = await poll([row("checkout api", "Net::Timeout Error", "Upstream timed out", 12)]);
    const key = result.items[0]!.key;
    assert.ok(KEY_PATTERN.test(key));
    assert.match(key, new RegExp(`^checkout-api/Net::Timeout-Error/${hash8("Upstream timed out")}#[0-9a-f]{8}$`));
  });

  test("UT-071 errors: an API key in an error message never appears in the item", async () => {
    const result = await poll([row("checkout-api", "AuthError", `bad key ${FAKE_KEY}`, 12)]);
    const text = JSON.stringify(result.items);
    assert.equal(text.includes(FAKE_KEY), false);
    assert.equal(text.includes("NRAK"), false);
  });

  test("UT-031b errors: 501 raw rows fail before regrouping; 500 rows are accepted", async () => {
    // Every row normalizes to one type, so the cap must count raw rows, not regrouped types.
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row("checkout-api", "NotFoundError", `Order ${i} not found`, 1));
    const error = await rejection(poll(rows(501)));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, "errors returned more than 500 rows; narrow with.where");
    const ok = await poll(rows(500));
    assert.equal((ok.items[0]!.attributes as { count: number }).count, 500);
  });

  test("UT-121 determinism: shuffled NerdGraph row order gives an identical errors result", async () => {
    const rows = [
      row("checkout-api", "NotFoundError", "Order 123 not found", 6),
      row("checkout-api", "NotFoundError", "Order 456 not found", 5),
      row("checkout-api", "TimeoutError", "Upstream timed out after 3000 ms", 37),
      row("cart", "TimeoutError", "Upstream timed out after 10 ms", 12),
      row("cart", "Rare", "rare", 2),
    ];
    const result = await assertRowOrderInvariant(rows, ordered => poll(ordered));
    assert.deepEqual(
      result.items.map(item => item.title),
      ["TimeoutError in checkout-api: 37 in 30m", "TimeoutError in cart: 12 in 30m", "NotFoundError in checkout-api: 11 in 30m"]
    );
  });

  test("IT-003b errors: a row without a numeric count is an unexpected response, not a params error (review R-3)", async () => {
    const error = await rejection(poll([{ facet: ["checkout-api", "TimeoutError", "boom"] }]));
    assert.equal(error.data?.code, "source_extension_failed");
    assert.equal(error.message, "New Relic request failed: unexpected response");
  });
});
