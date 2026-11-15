import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { HeartbeatSourceResult } from "@compozy/extension-sdk";

import { NRQL_QUERY } from "../src/nerdgraph.ts";
import { createPollHandler, type PollDeps } from "../src/poll.ts";
import { nrqlSource } from "../src/sources/nrql.ts";
import { type FakeNerdGraph, startFakeNerdGraph } from "./fake-nerdgraph.ts";
import { ACCOUNT, FAKE_KEY, pollRequest, rejection } from "./helpers.ts";

const NRQL = "SELECT percentile(duration, 95) FROM Transaction FACET appName SINCE 15 minutes ago";
const env = { NEW_RELIC_API_KEY: FAKE_KEY };
const quiet = { write: () => true };

let nr: FakeNerdGraph;
beforeEach(async () => {
  nr = await startFakeNerdGraph();
});
afterEach(async () => {
  await nr.close();
});

const params = (extra: Record<string, unknown> = {}) => ({
  account_id: ACCOUNT,
  region: nr.region,
  nrql: NRQL,
  threshold: 1.5,
  ...extra,
});
const p95 = (value: number) => [{ facet: "checkout-api", appName: "checkout-api", "percentile.duration": { "95": value } }];

async function poll(state: unknown, deps: PollDeps = {}, extra: Record<string, unknown> = {}): Promise<HeartbeatSourceResult> {
  return await createPollHandler(nrqlSource, { env, stderr: quiet, ...deps })(pollRequest(params(extra), state));
}

describe("nerdgraph client + nrql source against the fake NerdGraph", () => {
  test("IT-001 nrql: below, above, above across polls returns 0, 1, 0 items with API-Key and NRQL variables", async () => {
    nr.rows = p95(1.2);
    const first = await poll(null);
    nr.rows = p95(2.31);
    const second = await poll(first.state);
    const third = await poll(second.state);
    assert.deepEqual([first, second, third].map(r => r.items.length), [0, 1, 0]);
    assert.equal(second.items[0]?.title, `checkout-api above 1.5: 2.31 (p95 duration, account ${ACCOUNT})`);
    assert.equal(nr.requests.length, 3);
    for (const request of nr.requests) {
      assert.equal(request.path, "/graphql");
      assert.equal(request.headers["api-key"], FAKE_KEY);
      assert.equal(request.body.query, NRQL_QUERY);
      assert.deepEqual(request.body.variables, { id: ACCOUNT, q: NRQL });
    }
  });

  test("IT-004 errors: GraphQL errors on HTTP 200 map to source_params_invalid with at most 300 characters", async () => {
    const message = `NRQL Syntax error: unexpected token near ${"x".repeat(400)} ${FAKE_KEY}`;
    nr.respond = () => ({ status: 200, body: { data: null, errors: [{ message }] } });
    const error = await rejection(poll(null));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.ok(error.message.startsWith("New Relic rejected the query: NRQL Syntax error: unexpected token"));
    assert.ok(error.message.length <= "New Relic rejected the query: ".length + 300);
    assert.equal(error.message.includes("NRAK-"), false);
  });

  test("IT-005 errors: 401 maps to source_credential_expired and never echoes the key", async () => {
    nr.respond = () => ({ status: 401, body: { errors: [{ message: `bad key ${FAKE_KEY}` }] } });
    const lines: string[] = [];
    const error = await rejection(poll(null, { stderr: { write: line => lines.push(line) } }));
    assert.equal(error.data?.code, "source_credential_expired");
    assert.equal(error.message, "New Relic rejected the API key; bind a User API key (NRAK-...)");
    assert.deepEqual(lines, ["newrelic/nrql poll failed: code=source_credential_expired status=401\n"]);
    assert.equal(JSON.stringify({ message: error.message, data: error.data, lines }).includes(FAKE_KEY), false);
  });

  test("IT-006 errors: 403 with an auth error maps to source_credential_expired", async () => {
    nr.respond = () => ({ status: 403, body: { errors: [{ message: "Forbidden: invalid credentials" }] } });
    assert.equal((await rejection(poll(null))).data?.code, "source_credential_expired");
  });

  test("IT-007 errors: 429 maps to source_rate_limited", async () => {
    nr.respond = () => ({ status: 429, body: { errors: [{ message: "Too many requests" }] } });
    const error = await rejection(poll(null));
    assert.equal(error.data?.code, "source_rate_limited");
    assert.equal(error.message, "New Relic rate limit reached; retry later");
  });

  test("IT-008 errors: 503 maps to source_extension_failed", async () => {
    nr.respond = () => ({ status: 503, body: "Service Unavailable" });
    const error = await rejection(poll(null));
    assert.equal(error.data?.code, "source_extension_failed");
    assert.equal(error.message, "New Relic request failed: 503");
  });

  test("IT-009 errors: no answer within the request timeout maps to source_extension_failed", async () => {
    // The fake holds the answer for 11 s; an injected 100 ms timeout stands in for the 10 s default.
    nr.respond = () => ({ status: 200, body: { data: {} }, delayMs: 11_000 });
    const started = performance.now();
    const error = await rejection(poll(null, { requestTimeoutMs: 100 }));
    assert.equal(error.data?.code, "source_extension_failed");
    assert.equal(error.message, "New Relic request failed: no answer within 0.1s");
    assert.ok(performance.now() - started < 5_000);
  });

  test("IT-010 region: eu sends requests to the EU NerdGraph host", async () => {
    const urls: string[] = [];
    const routed = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const local = url.replace("https://api.eu.newrelic.com/", `http://127.0.0.1:${nr.port}/eu/`);
      return await fetch(local, init);
    }) as typeof fetch;
    nr.rows = p95(1.0);
    const result = await poll(null, { fetch: routed }, { region: "eu" });
    assert.deepEqual(urls, ["https://api.eu.newrelic.com/graphql"]);
    assert.equal(nr.requests[0]?.path, "/eu/graphql");
    assert.deepEqual(result.items, []);
  });

  test("IT-011 errors: GraphQL errors naming account access map to the account message", async () => {
    nr.respond = () => ({
      status: 200,
      body: {
        data: { actor: { account: null } },
        errors: [{ message: `Not authorized to access account ${ACCOUNT}`, extensions: { errorClass: "FORBIDDEN" } }],
      },
    });
    const error = await rejection(poll(null));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, `this API key cannot read account ${ACCOUNT}`);
    // A null account without errors means the same.
    nr.respond = () => ({ status: 200, body: { data: { actor: { account: null } } } });
    assert.equal((await rejection(poll(null))).message, `this API key cannot read account ${ACCOUNT}`);
  });

  test("IT-004 errors: errorClass decides over message words, so a syntax error mentioning timeout keeps its text (review R-8)", async () => {
    const syntax = "NRQL Syntax error: unknown function timeout() near account permission";
    nr.respond = () => ({ status: 200, body: { data: null, errors: [{ message: syntax, extensions: { errorClass: "INVALID_INPUT" } }] } });
    const error = await rejection(poll(null));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, `New Relic rejected the query: ${syntax}`);
    // A TIMEOUT class still maps to a failed request whatever the message says.
    nr.respond = () => ({ status: 200, body: { data: null, errors: [{ message: "NRDB query failed", extensions: { errorClass: "TIMEOUT" } }] } });
    const timeout = await rejection(poll(null));
    assert.deepEqual([timeout.data?.code, timeout.message], ["source_extension_failed", "New Relic request failed: query timed out"]);
  });
});
