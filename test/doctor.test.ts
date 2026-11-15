import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatProbeLine, formatReport, runDoctor } from "../src/doctor.ts";
import { FAKE_KEY } from "./helpers.ts";

const env = { NEW_RELIC_API_KEY: FAKE_KEY };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Fake fetch: NerdGraph answers `accounts` ids; the MCP URL answers `mcp(body)`. */
function fakeFetch(accounts: number, mcp: (body: Record<string, unknown>) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/graphql")) {
      return Response.json({ data: { actor: { accounts: Array.from({ length: accounts }, (_, id) => ({ id })) } } });
    }
    return await mcp(seen[seen.length - 1]!.body);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, seen };
}

const initialize = (capabilities: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities, serverInfo: { name: "nr", version: "1" } } });

const READ = { readOnlyHint: true };
const CATALOG = [
  { name: "list_recent_issues", annotations: READ },
  { name: "analyze_transactions", annotations: READ },
  { name: "natural_language_to_nrql_query", annotations: READ },
  { name: "search_traces", annotations: READ },
  { name: "delete_dashboard", annotations: { readOnlyHint: false, destructiveHint: true } },
];

/** A working MCP: initialize (session s-1), the initialized notification, then one tools/list page. */
function mcpServer(wrap: (body: unknown) => Response = body => Response.json(body, { headers: { "Mcp-Session-Id": "s-1" } })) {
  return (body: Record<string, unknown>) => {
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return wrap({ jsonrpc: "2.0", id: body.id, result: { tools: CATALOG } });
    return wrap({ ...initialize({ tools: {} }), id: body.id });
  };
}

describe("doctor", () => {
  test("UT-100 doctor: NerdGraph ok with 21 accounts and MCP tools/list → available with exposed and OAuth-only counts", async () => {
    const { fetch, seen } = fakeFetch(21, mcpServer());
    const report = await runDoctor("us", { env, fetch });
    assert.equal(
      formatReport(report),
      "NerdGraph: ok (region us, 21 accounts visible)\n" +
        "MCP: available (2 tools exposed via API key; 2 OAuth-only hidden) — agents can use ext__newrelic__mcp_tools / mcp_call"
    );
    assert.equal(formatProbeLine(report), "newrelic: probe region=us nerdgraph=ok mcp=available\n");
    const mcp = seen.filter(call => call.url === "https://mcp.newrelic.com/mcp/");
    assert.deepEqual(mcp.map(call => call.body.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert.ok(mcp.every(call => call.headers["api-key"] === FAKE_KEY));
    assert.equal((mcp[0]?.body.params as { protocolVersion: string }).protocolVersion, "2025-06-18");
    assert.equal(mcp[2]?.headers["Mcp-Session-Id"], "s-1");
    assert.ok(!seen.some(call => call.body.method === "tools/call"));

    const sse = fakeFetch(1, mcpServer(body => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s-2" },
    })));
    const eu = formatReport(await runDoctor("eu", { env, fetch: sse.fetch }));
    assert.equal(eu.split("\n")[0], "NerdGraph: ok (region eu, 1 account visible)");
    assert.match(eu, /MCP: available \(2 tools exposed via API key; 2 OAuth-only hidden\)/);
    assert.ok(sse.seen.some(call => call.url === "https://mcp.eu.newrelic.com/mcp/"));
  });

  test("UT-101 doctor: MCP 403 → unavailable with the URL and the keep-ext-tools hint", async () => {
    const { fetch } = fakeFetch(1, () => new Response("forbidden", { status: 403 }));
    const report = await runDoctor("us", { env, fetch });
    assert.equal(
      formatReport(report),
      "NerdGraph: ok (region us, 1 account visible)\n" +
        "MCP: unavailable (403 from https://mcp.newrelic.com/mcp/) — agents keep the ext__newrelic__* tools; skip the MCP login"
    );
    assert.equal(formatProbeLine(report), "newrelic: probe region=us nerdgraph=ok mcp=unavailable:403\n");
    for (const status of [401, 404]) {
      const other = await runDoctor("us", { env, fetch: fakeFetch(1, () => new Response("", { status })).fetch });
      assert.deepEqual(other.mcp, { status: "unavailable", http: status });
    }
  });

  test("UT-102 doctor: MCP network error, 5xx or no tools → unknown, and the doctor still answers", async () => {
    const down = fakeFetch(2, () => {
      throw new TypeError("fetch failed");
    });
    const report = await runDoctor("us", { env, fetch: down.fetch });
    assert.equal(
      formatReport(report).split("\n")[1],
      "MCP: unknown (network error) — agents keep the ext__newrelic__* tools; run the doctor again later"
    );
    assert.equal(formatProbeLine(report), "newrelic: probe region=us nerdgraph=ok mcp=unknown\n");
    const accounts = fakeFetch(2, () => new Response("", { status: 500 }));
    const slowFetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/graphql")) return accounts.fetch(url, init);
      return await new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }) as unknown as typeof fetch;
    const keepAlive = setTimeout(() => {}, 1000); // Node unrefs AbortSignal.timeout timers
    assert.deepEqual((await runDoctor("us", { env, fetch: slowFetch, mcpTimeoutMs: 20 })).mcp, { status: "unknown", error: "no answer within 0.02s" });
    clearTimeout(keepAlive);
    assert.deepEqual((await runDoctor("us", { env, fetch: fakeFetch(1, () => new Response("", { status: 502 })).fetch })).mcp, { status: "unknown", error: "HTTP 502" });
    assert.deepEqual((await runDoctor("us", { env, fetch: fakeFetch(1, () => Response.json(initialize({}))).fetch })).mcp, {
      status: "unknown",
      error: "no tools capability in initialize result",
    });
  });

  test("UT-102 doctor: without a key it reports both probes and makes no network call", async () => {
    const noFetch = (() => {
      throw new Error("network must not be used");
    }) as unknown as typeof fetch;
    const report = await runDoctor("us", { env: {}, fetch: noFetch });
    assert.equal(
      formatReport(report),
      "NerdGraph: failed (New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY)\n" +
        "MCP: unknown (no API key) — agents keep the ext__newrelic__* tools; run the doctor again later"
    );
    assert.equal(formatProbeLine(report), "newrelic: probe region=us nerdgraph=credential_absent mcp=unknown\n");
  });
});
