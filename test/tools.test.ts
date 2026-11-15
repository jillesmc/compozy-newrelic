import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RPCError, ToolResult } from "@compozy/extension-sdk";

import type { NerdGraphClient } from "../src/nerdgraph.ts";
import { MAX_TOOL_BYTES } from "../src/tools/format.ts";
import { alertIssuesTool, entitySearchQuery, listAccountsTool, searchEntitiesTool } from "../src/tools/graph-tools.ts";
import { toolHandler, TOOLS } from "../src/tools/index.ts";
import { errorGroupsTool, nrqlQueryTool, recentLogsTool } from "../src/tools/nrql-tools.ts";
import type { NerdGraphTool, ToolContext } from "../src/tools/tool.ts";
import { ACCOUNT, NOW } from "./helpers.ts";

interface Call {
  gql: string;
  variables: Record<string, unknown>;
}

/** Unit-level context: a NerdGraph client answering `answer(call)` for every query or NRQL. */
function context(answer: (call: Call) => unknown): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const client: NerdGraphClient = {
    async query<T>(gql: string, variables: Record<string, unknown>) {
      const call = { gql, variables };
      calls.push(call);
      return structuredClone(answer(call)) as T;
    },
    async nrql(id: number, nrql: string) {
      const call = { gql: nrql, variables: { id } };
      calls.push(call);
      return structuredClone(answer(call)) as Record<string, unknown>[];
    },
  };
  const ctx = {
    client,
    endpoints: { graphql: "", mcp: "", web: "https://one.newrelic.com" },
    signal: new AbortController().signal,
    now: () => new Date(NOW),
  };
  return { ctx, calls };
}

async function run(tool: NerdGraphTool, input: Record<string, unknown>, answer: (call: Call) => unknown) {
  const { ctx, calls } = context(answer);
  const result = await tool.run(input, ctx);
  return { result, calls, rows: (result.structured as { rows: Record<string, unknown>[] }).rows };
}

function assertBounded(result: ToolResult): void {
  const text = result.content?.[0]?.text ?? "";
  assert.ok(Buffer.byteLength(text) <= MAX_TOOL_BYTES, `text ${Buffer.byteLength(text)} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structured)) <= MAX_TOOL_BYTES);
  assert.equal((result.structured as { truncated: boolean }).truncated, result.truncated);
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("investigation tools", () => {
  test("UT-090 nrql_query: compact table of at most 50 rows within 8 KiB, truncated when cut", async () => {
    const small = await run(nrqlQueryTool, { account_id: ACCOUNT, nrql: "SELECT count(*) FROM Transaction FACET appName" }, () => [
      { facet: "checkout-api", appName: "checkout-api", count: 12 },
      { facet: "cart", appName: "cart", count: 3, "percentile.duration": { "95": 1.5 } },
    ]);
    assert.equal(small.result.content?.[0]?.text, [
      "facet | appName | count | percentile.duration",
      "checkout-api | checkout-api | 12 | ",
      'cart | cart | 3 | {"95":1.5}',
    ].join("\n"));
    assert.equal(small.result.truncated, false);
    assert.deepEqual(small.calls[0]?.variables, { id: ACCOUNT });

    const many = await run(nrqlQueryTool, { account_id: ACCOUNT, nrql: "SELECT *" }, () => range(60).map(i => ({ n: i })));
    assert.equal(many.rows.length, 50);
    assert.equal(many.result.truncated, true);
    assertBounded(many.result);

    const wide = await run(nrqlQueryTool, { account_id: ACCOUNT, nrql: "SELECT *" }, () => range(50).map(i => ({ n: i, text: "x".repeat(1000) })));
    assert.ok(wide.rows.length < 50 && wide.rows.length > 0);
    assert.equal(wide.result.truncated, true);
    assert.equal((wide.rows[0]?.text as string).length, 300);
    assertBounded(wide.result);
  });

  test("UT-091 list_accounts: {id, name} sorted by id, at most 50", async () => {
    const { rows, result } = await run(listAccountsTool, {}, () => ({
      actor: { accounts: range(60).map(i => ({ id: 1000 - i, name: `acct ${i}` })) },
    }));
    assert.equal(rows.length, 50);
    assert.deepEqual(rows[0], { id: 941, name: "acct 59" });
    assert.equal(result.truncated, true);
    assertBounded(result);
  });

  test("UT-092 search_entities: bare names become a LIKE search, at most 25 compact entities", async () => {
    assert.equal(entitySearchQuery("checkout"), "name LIKE 'checkout'");
    assert.equal(entitySearchQuery("o'neil"), "name LIKE 'o\\'neil'");
    assert.equal(entitySearchQuery("domain = 'APM'"), "domain = 'APM'");
    const { rows, result, calls } = await run(searchEntitiesTool, { query: "checkout" }, () => ({
      actor: { entitySearch: { results: { entities: range(30).map(i => ({ guid: `G${i}`, name: `checkout-${i}`, type: "APPLICATION", domain: "APM", alertSeverity: "NOT_ALERTING", tags: ["x"] })) } } },
    }));
    assert.deepEqual(calls[0]?.variables, { q: "name LIKE 'checkout'" });
    assert.equal(rows.length, 25);
    assert.deepEqual(rows[0], { guid: "G0", name: "checkout-0", type: "APPLICATION", domain: "APM", alert_severity: "NOT_ALERTING" });
    assert.equal(result.truncated, true);
    assertBounded(result);
  });

  test("UT-093 alert_issues: public aiIssues fields, priority then newest first, since filter, paging", async () => {
    const hour = 3_600_000;
    const now = Date.parse(NOW);
    const pages: Record<string, unknown> = {
      first: { issues: [
        { issueId: "low", title: ["Disk"], priority: "LOW", state: "ACTIVATED", entityNames: ["db"], activatedAt: now - hour, createdAt: now - hour },
        { issueId: "old", title: ["CPU high", "CPU very high"], priority: "CRITICAL", state: "ACTIVATED", entityNames: ["api", "web"], activatedAt: String(now - 30 * hour) },
      ], nextCursor: "c2" },
      c2: { issues: [{ issueId: "new", title: ["Errors"], priority: "CRITICAL", state: "CREATED", entityNames: [], activatedAt: null, createdAt: String(now - 2 * hour) }], nextCursor: null },
    };
    const answer = (call: Call) => ({ actor: { account: { aiIssues: { issues: pages[String(call.variables.cursor ?? "first")] } } } });
    const all = await run(alertIssuesTool, { account_id: ACCOUNT }, answer);
    assert.deepEqual(all.rows.map(row => row.id), ["new", "old", "low"]);
    assert.deepEqual(all.rows[1], {
      id: "old",
      title: "CPU high; CPU very high",
      priority: "CRITICAL",
      state: "ACTIVATED",
      entities: "api, web",
      opened_at: new Date(now - 30 * hour).toISOString(),
      url: "https://one.newrelic.com",
    });
    assert.equal(all.calls.length, 2);
    assert.deepEqual(all.calls.map(call => call.variables), [{ id: ACCOUNT, cursor: null }, { id: ACCOUNT, cursor: "c2" }]);
    assert.match(all.calls[0]!.gql, /issues\(filter:\{states:\[ACTIVATED,CREATED\]\},cursor:\$cursor\)/);
    assert.doesNotMatch(all.calls[0]!.gql, /conditionName|policyName/);

    const recent = await run(alertIssuesTool, { account_id: ACCOUNT, since: "24h", state: "all", priorities: ["HIGH", "CRITICAL"] }, answer);
    assert.deepEqual(recent.rows.map(row => row.id), ["new", "low"]);
    assert.match(recent.calls[0]!.gql, /issues\(filter:\{priority:\["CRITICAL","HIGH"\]\},cursor/);

    const many = await run(alertIssuesTool, { account_id: ACCOUNT, state: "closed" }, () => ({
      actor: { account: { aiIssues: { issues: { issues: range(30).map(i => ({ issueId: `i${i}`, title: ["t"], priority: "HIGH", state: "CLOSED", createdAt: now - i })), nextCursor: null } } } },
    }));
    assert.equal(many.rows.length, 25);
    assert.equal(many.result.truncated, true);
    assert.match(many.calls[0]!.gql, /states:\[CLOSED,DEACTIVATED\]/);
    assertBounded(many.result);

    await assert.rejects(run(alertIssuesTool, { account_id: ACCOUNT }, () => ({ actor: { account: null } })), {
      message: `this API key cannot read account ${ACCOUNT}`,
    });
    await assert.rejects(run(alertIssuesTool, { account_id: ACCOUNT, priorities: ["URGENT"] }, answer), /priorities must list/);
  });

  test("UT-094 error_groups: normalized messages are grouped and summed, most frequent first, at most 25", async () => {
    const { rows, calls, result } = await run(errorGroupsTool, { account_id: ACCOUNT, where: "appName = 'checkout-api'", window: "1h" }, () => [
      { facet: ["checkout-api", "NotFound", "Order 123 not found"], count: 4, "max.timestamp": Date.parse(NOW) - 60_000 },
      { facet: ["checkout-api", "NotFound", "Order 456 not found"], count: 3, "max.timestamp": Date.parse(NOW) },
      { facet: ["checkout-api", "Timeout", "upstream timed out"], count: 5, "max.timestamp": Date.parse(NOW) },
    ]);
    assert.equal(
      calls[0]?.gql,
      "SELECT count(*), max(timestamp) FROM TransactionError WHERE appName = 'checkout-api' FACET appName, error.class, error.message SINCE 60 minutes ago LIMIT 500"
    );
    assert.deepEqual(rows[0], { app: "checkout-api", class: "NotFound", message: "Order # not found", count: 7, last_seen: NOW.replace("Z", ".000Z") });
    assert.equal(rows[1]?.class, "Timeout");
    assert.equal(result.truncated, false);

    const many = await run(errorGroupsTool, { account_id: ACCOUNT }, () => range(40).map(i => ({ facet: ["a", `E${i}`, "m".repeat(400)], count: i })));
    assert.match(many.calls[0]!.gql, /FROM TransactionError FACET .* SINCE 30 minutes ago/);
    assert.equal(many.rows.length, 25);
    assert.equal(many.rows[0]?.class, "E39");
    assert.equal((many.rows[0]?.message as string).length, 160);
    assertBounded(many.result);
  });

  test("UT-095 recent_logs: at most 50 lines of at most 300 characters", async () => {
    const lines = (n: number) => range(n).map(i => ({ timestamp: Date.parse(NOW) - i, "service.name": "checkout", level: "error", message: `line ${i} ${"y".repeat(500)}` }));
    const { rows, calls, result } = await run(recentLogsTool, { account_id: ACCOUNT, where: "level = 'error'", limit: 50 }, () => lines(50));
    assert.equal(calls[0]?.gql, "SELECT timestamp, service.name, level, message FROM Log WHERE level = 'error' SINCE 15 minutes ago LIMIT 50");
    assert.ok(rows.length <= 50 && rows.length > 0);
    assert.ok(rows.every(row => Array.from(row.message as string).length <= 300));
    assert.deepEqual(Object.keys(rows[0]!), ["timestamp", "service", "level", "message"]);
    assert.equal(rows[0]?.timestamp, new Date(Date.parse(NOW)).toISOString());
    assertBounded(result);

    const few = await run(recentLogsTool, { account_id: ACCOUNT, where: "true" }, () => lines(3));
    assert.match(few.calls[0]!.gql, /LIMIT 20$/);
    assert.equal(few.result.truncated, false);
    await assert.rejects(run(recentLogsTool, { account_id: ACCOUNT, where: "true", limit: 51 }, () => []), /limit must be an integer from 1 to 50/);
  });

  test("UT-090..UT-095 tools: without a key → credential_absent error naming the secrets command, no network call", async () => {
    const noFetch = (() => {
      throw new Error("network must not be used");
    }) as unknown as typeof fetch;
    for (const tool of TOOLS.filter(t => t.name !== "doctor")) {
      const handler = toolHandler(tool, { env: {}, fetch: noFetch });
      await assert.rejects(Promise.resolve(handler({ input: { account_id: ACCOUNT, nrql: "x", query: "x", where: "x" } } as never)), (error: RPCError<{ code: string }>) => {
        assert.equal(error.data?.code, "credential_absent", tool.name);
        assert.match(error.message, /compozy extension secrets set newrelic --env NEW_RELIC_API_KEY/);
        return true;
      });
    }
    const wrongKey = toolHandler(TOOLS[0]!, { env: { NEW_RELIC_API_KEY: "NRII-ingest" }, fetch: noFetch });
    await assert.rejects(Promise.resolve(wrongKey({ input: { account_id: ACCOUNT, nrql: "x" } } as never)), { data: { code: "credential_expired" } });
  });
});
