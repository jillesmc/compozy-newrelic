import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createPollHandler } from "../src/poll.ts";
import { errorsSource } from "../src/sources/errors.ts";
import { issuesSource } from "../src/sources/issues.ts";
import { logsSource } from "../src/sources/logs.ts";
import type { SourceDefinition } from "../src/sources/source.ts";
import { type FakeNerdGraph, startFakeNerdGraph } from "./fake-nerdgraph.ts";
import { ACCOUNT, FAKE_KEY, pollRequest } from "./helpers.ts";

const env = { NEW_RELIC_API_KEY: FAKE_KEY };
const quiet = { write: () => true };

let nr: FakeNerdGraph;
beforeEach(async () => {
  nr = await startFakeNerdGraph();
});
afterEach(async () => {
  await nr.close();
});

const poll = (source: SourceDefinition, params: Record<string, unknown>, state: unknown = null) =>
  createPollHandler(source, { env, stderr: quiet })(pollRequest({ account_id: ACCOUNT, region: nr.region, ...params }, state));

describe("issues, errors and logs sources against the fake NerdGraph", () => {
  test("IT-002 issues: nextCursor pagination across 2 pages merges the results", async () => {
    nr.issuePageSize = 2;
    nr.issues = ["a", "b", "c"].map((id, i) => ({
      issueId: `issue-${id}`,
      title: [`trouble ${id}`],
      priority: "CRITICAL",
      state: "ACTIVATED",
      entityNames: ["checkout-api"],
      activatedAt: String(1_794_000_000_000 + i),
    }));
    const result = await poll(issuesSource, { notify_existing: true });
    assert.deepEqual(result.items.map(item => item.key), ["issue-a", "issue-b", "issue-c"]);
    assert.equal(nr.requests.length, 2);
    assert.ok(!(nr.requests[0]!.body.query ?? "").includes("cursor:"));
    assert.ok((nr.requests[1]!.body.query ?? "").includes(',cursor:"2"'));
    for (const request of nr.requests) {
      assert.equal(request.headers["api-key"], FAKE_KEY);
      assert.deepEqual(request.body.variables, { id: ACCOUNT });
      assert.equal(request.headers["nerd-graph-unsafe-experimental-opt-in"], undefined);
    }
  });

  test("IT-003 errors: the source sends the expected NRQL text", async () => {
    nr.rows = [{ facet: ["checkout-api", "TimeoutError", "Upstream timed out after 3000 ms"], count: 37 }];
    const result = await poll(errorsSource, { where: "appName = 'checkout-api'", min_count: 10, notify_existing: true });
    assert.equal(nr.requests[0]?.body.variables?.q,
      "SELECT count(*) FROM TransactionError WHERE appName = 'checkout-api' FACET appName, error.class, error.message SINCE 30 minutes ago LIMIT 501");
    assert.deepEqual(result.items.map(item => item.title), ["TimeoutError in checkout-api: 37 in 30m"]);
  });

  test("IT-003 logs: the source sends the expected NRQL text", async () => {
    nr.rows = [{ facet: "payments", "service.name": "payments", count: 120 }];
    const first = await poll(logsSource, { where: "level = 'error'", facet: "service.name", threshold: 50 });
    assert.equal(nr.requests[0]?.body.variables?.q,
      "SELECT count(*) FROM Log WHERE level = 'error' FACET service.name SINCE 15 minutes ago LIMIT 501");
    assert.deepEqual(first.items, []); // quiet baseline
    nr.rows = [...nr.rows, { facet: "auth", "service.name": "auth", count: 51 }];
    const second = await poll(logsSource, { where: "level = 'error'", facet: "service.name", threshold: 50 }, first.state);
    assert.deepEqual(second.items.map(item => item.title), ["auth: 51 log lines in 15m (threshold 50)"]);
  });
});
