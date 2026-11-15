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

/** Fake fetch: NerdGraph answers `accounts` ids; the MCP URL answers `mcp()`. */
function fakeFetch(accounts: number, mcp: () => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/graphql")) {
      return Response.json({ data: { actor: { accounts: Array.from({ length: accounts }, (_, id) => ({ id })) } } });
    }
    return await mcp();
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, seen };
}

const initialize = (capabilities: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities, serverInfo: { name: "nr", version: "1" } } });

describe("doctor", () => {
  test("UT-100 doctor: NerdGraph ok with 21 accounts and MCP 200 with tools → available plus the login hint", async () => {
    const { fetch, seen } = fakeFetch(21, () => Response.json(initialize({ tools: {} })));
    const report = await runDoctor("us", { env, fetch });
    assert.equal(
      formatReport(report),
      "NerdGraph: ok (region us, 21 accounts visible)\n" +
        "MCP: available — run `compozy mcp auth login newrelic` to give agents the official New Relic tools"
    );
    assert.equal(formatProbeLine(report), "newrelic: probe region=us nerdgraph=ok mcp=available\n");
    const mcp = seen.find(call => call.url === "https://mcp.newrelic.com/mcp/");
    assert.equal(mcp?.headers["api-key"], FAKE_KEY);
    assert.equal(mcp?.body.method, "initialize");
    assert.equal((mcp?.body.params as { protocolVersion: string }).protocolVersion, "2025-06-18");
    assert.deepEqual(seen.map(call => call.body.method ?? "graphql").sort(), ["graphql", "initialize"]);

    const sse = fakeFetch(1, () => new Response(`event: message\ndata: ${JSON.stringify(initialize({ tools: { listChanged: true } }))}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const eu = formatReport(await runDoctor("eu", { env, fetch: sse.fetch }));
    assert.equal(eu.split("\n")[0], "NerdGraph: ok (region eu, 1 account visible)");
    assert.match(eu, /compozy mcp auth login newrelic-eu/);
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
