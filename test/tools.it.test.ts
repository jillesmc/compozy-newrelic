import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { ToolResult } from "@compozy/extension-sdk";
import { TestHarness } from "@compozy/extension-sdk/testing";

import { createExtension } from "../src/index.ts";
import { toolHandler, TOOLS } from "../src/tools/index.ts";
import { type FakeNerdGraph, startFakeNerdGraph } from "./fake-nerdgraph.ts";
import { ACCOUNT, FAKE_KEY } from "./helpers.ts";

const env = { NEW_RELIC_API_KEY: FAKE_KEY };

let nr: FakeNerdGraph;
beforeEach(async () => {
  nr = await startFakeNerdGraph();
});
afterEach(async () => {
  await nr.close();
});

async function call(name: string, input: Record<string, unknown>): Promise<ToolResult | string> {
  const tool = TOOLS.find(entry => entry.name === name)!;
  return (await toolHandler(tool, { env })({ input: { region: nr.region, ...input } } as never)) as ToolResult | string;
}

/** Answers the GraphQL (non-NRQL) tool queries by their shape. */
function graphAnswers(request: { body: { query?: string } }) {
  const query = request.body.query ?? "";
  if (query.includes("accounts{id name}")) return { status: 200, body: { data: { actor: { accounts: [{ id: ACCOUNT, name: "Prod" }] } } } };
  if (query.includes("entitySearch")) {
    return { status: 200, body: { data: { actor: { entitySearch: { results: { entities: [{ guid: "MXxBUE18", name: "checkout-api", type: "APPLICATION", domain: "APM", alertSeverity: "CRITICAL" }] } } } } } };
  }
  if (query.includes("aiIssues")) {
    const issue = { issueId: "abc-1", title: ["p95 high"], priority: "CRITICAL", state: "ACTIVATED", entityNames: ["checkout-api"], activatedAt: "1763121600000" };
    return { status: 200, body: { data: { actor: { account: { aiIssues: { issues: { issues: [issue], nextCursor: null } } } } } } };
  }
  return undefined;
}

describe("tools and doctor against the fake NerdGraph and MCP", () => {
  test("IT-012 tools: each tool returns its documented compact shape over HTTP with the API-Key header", async () => {
    nr.respond = graphAnswers;
    nr.rows = [{ facet: ["checkout-api", "TimeoutError", "Upstream timed out after 3000 ms"], count: 37, "max.timestamp": 1763121600000 }];
    const rowsOf = (result: ToolResult | string) => (result as ToolResult).structured as { rows: Record<string, unknown>[]; truncated: boolean };

    const nrql = (await call("nrql_query", { account_id: ACCOUNT, nrql: "SELECT count(*) FROM Transaction" })) as ToolResult;
    assert.match(nrql.content?.[0]?.text ?? "", /^facet \| count \| max.timestamp\n/);
    assert.deepEqual(rowsOf(await call("list_accounts", {})), { rows: [{ id: ACCOUNT, name: "Prod" }], truncated: false });
    assert.deepEqual(Object.keys(rowsOf(await call("search_entities", { query: "checkout" })).rows[0]!), ["guid", "name", "type", "domain", "alert_severity"]);
    assert.deepEqual(rowsOf(await call("alert_issues", { account_id: ACCOUNT })).rows[0], {
      id: "abc-1", title: "p95 high", priority: "CRITICAL", state: "ACTIVATED", entities: "checkout-api", opened_at: "2025-11-14T12:00:00.000Z", url: null,
    });
    assert.deepEqual(rowsOf(await call("error_groups", { account_id: ACCOUNT })).rows[0], {
      app: "checkout-api", class: "TimeoutError", message: "Upstream timed out after # ms", count: 37, last_seen: "2025-11-14T12:00:00.000Z",
    });
    nr.rows = [{ timestamp: 1763121600000, "service.name": "checkout", level: "error", message: `boom ${FAKE_KEY}` }];
    const logs = await call("recent_logs", { account_id: ACCOUNT, where: "level = 'error'" });
    assert.deepEqual(rowsOf(logs).rows[0], { timestamp: "2025-11-14T12:00:00.000Z", service: "checkout", level: "error", message: "boom [redacted]" });
    assert.ok(!JSON.stringify(logs).includes(FAKE_KEY));

    assert.equal(nr.requests.length, 6);
    for (const request of nr.requests) {
      assert.equal(request.path, "/graphql");
      assert.equal(request.headers["api-key"], FAKE_KEY);
      assert.doesNotMatch(request.body.query ?? "", /mutation/i);
    }
  });

  test("IT-012 doctor: the tool prints the report from the loopback NerdGraph and MCP", async () => {
    nr.respond = request => (request.path === "/graphql" ? { status: 200, body: { data: { actor: { accounts: [{ id: 1 }, { id: 2 }] } } } } : undefined);
    assert.equal(
      await call("doctor", {}),
      `NerdGraph: ok (region ${nr.region}, 2 accounts visible)\n` +
        "MCP: available (7 tools exposed via API key; 2 OAuth-only hidden) — agents can use ext__newrelic__mcp_tools / mcp_call"
    );
    assert.deepEqual(nr.mcpFake.requests.map(request => request.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert.ok(nr.mcpFake.requests.every(request => request.headers["api-key"] === FAKE_KEY));
    nr.mcp = { status: 403 };
    assert.match(String(await call("doctor", {})), /MCP: unavailable \(403 from http:\/\/127\.0\.0\.1:\d+\/mcp\/\)/);
  });

  test("IT-013 startup: initialize triggers exactly one stderr probe line with nerdgraph= and mcp=, never the key", async () => {
    const lines: string[] = [];
    const stderr = { write: (line: string) => lines.push(line) };
    // The startup probe uses region us; route its HTTPS URLs to the loopback fake (no real New Relic call).
    const routed = ((url: string, init: RequestInit) =>
      fetch(url.replace(/^https:\/\/(api|mcp)\.newrelic\.com/, `http://127.0.0.1:${nr.port}`), init)) as typeof fetch;
    nr.respond = request => (request.path === "/graphql" ? { status: 200, body: { data: { actor: { accounts: [{ id: 1 }] } } } } : undefined);
    const harness = new TestHarness({ stderr: new Writable({ write: (_chunk, _encoding, done) => done() }) });
    await harness.loadExtension(options => createExtension(options, { env, fetch: routed, stderr }));
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(lines, ["newrelic: probe region=us nerdgraph=ok mcp=available\n"]);
    assert.ok(!lines.join("").includes(FAKE_KEY));
    assert.deepEqual([...new Set(nr.requests.map(request => request.path))].sort(), ["/graphql", "/mcp/"]);
    assert.ok(!nr.mcpFake.requests.some(request => request.method === "tools/call"));
  });

  test("IT-012 tools: the per-call budget ends a slow call with tool budget exceeded (review R-5)", async () => {
    // The fake holds the answer for 11 s; an injected 100 ms budget stands in for the 25 s default.
    nr.respond = () => ({ status: 200, body: { data: {} }, delayMs: 11_000 });
    const tool = TOOLS.find(entry => entry.name === "nrql_query")!;
    const started = performance.now();
    await assert.rejects(
      Promise.resolve(
        toolHandler(tool, { env, budgetMs: 100 })({ input: { region: nr.region, account_id: ACCOUNT, nrql: "SELECT 1" } } as never)
      ),
      // Deviation D-18: a CompozyOS ToolError; the budget is a timeout.
      {
        message: "extension_failed: New Relic request failed: tool budget exceeded",
        data: { code: "tool_timed_out", message: "extension_failed: New Relic request failed: tool budget exceeded" },
      }
    );
    assert.ok(performance.now() - started < 5_000);
  });
});
