import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";

import { CATALOG_TTL_MS, RETRY_MS } from "../src/mcp-catalog.ts";
import { createMcpClient, McpError } from "../src/mcp-client.ts";
import { createNerdGraphClient } from "../src/nerdgraph.ts";
import { createProxyCatalog } from "../src/tools/mcp-proxy.ts";
import { decodeToolError, FAKE_KEY, out, startProxyHarness, toolFailure } from "./helpers.ts";

/** Review findings R-1..R-6 (_review-codex.md): regressions at the network boundary. */
const READ = { readOnlyHint: true };
const KEY_PREFIX = "NRAK-"; // any part of the key left after a cut still starts with this
let h: Awaited<ReturnType<typeof startProxyHarness>>;
beforeEach(async () => {
  h = await startProxyHarness();
});
afterEach(async () => {
  await h.nr.close();
});

async function listen(handler: (headers: IncomingHttpHeaders, res: import("node:http").ServerResponse) => void): Promise<Server & { port: number }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req.headers, res));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(server, { port: (server.address() as AddressInfo).port });
}

describe("MCP proxy hardening (review R-1..R-6)", () => {
  test("UT-190 redaction (R-1): an OAuth-learned tool name carrying the key is redacted in stderr and operator.cause", async () => {
    const name = `oauth_${FAKE_KEY}`;
    h.nr.mcpFake.tools.push({ name, annotations: READ, behavior: "oauth" });
    let caught: unknown;
    try {
      await h.call("mcp_call", { tool: name });
    } catch (error) {
      caught = error;
    }
    const decoded = decodeToolError(caught);
    assert.equal(decoded.reason, "oauth_only");
    assert.ok(!JSON.stringify((caught as { data: unknown }).data).includes(KEY_PREFIX));
    assert.ok(h.lines.some(line => line.startsWith("newrelic: mcp tool oauth_?redacted? requires OAuth")), h.lines.join(""));
    assert.ok(!h.lines.join("").includes(KEY_PREFIX));
    // The production catalog (index.ts / tool fallback) carries the key redactor too.
    const lines: string[] = [];
    const catalog = createProxyCatalog({ env: { NEW_RELIC_API_KEY: FAKE_KEY }, stderr: { write: line => lines.push(line) } });
    catalog.learnOAuthOnly(`${FAKE_KEY}_tool`);
    assert.deepEqual(lines, ["newrelic: mcp tool ?redacted?_tool requires OAuth; hidden\n"]);
  });

  test("UT-190 redaction (R-3): remote names, descriptions, schema text and placeholders are redacted before they are cut", async () => {
    h.nr.mcpFake.tools = [
      {
        name: `tool_${FAKE_KEY}`,
        description: `${"x".repeat(190)}${FAKE_KEY}`,
        annotations: READ,
        inputSchema: { type: "object", properties: { [`p_${FAKE_KEY}`]: { type: "string", description: `${"x".repeat(70)}${FAKE_KEY}` } } },
      },
      { name: "resource_report", annotations: READ },
    ];
    const listed = JSON.stringify(await h.call("mcp_tools"));
    assert.ok(!listed.includes(KEY_PREFIX), listed.slice(0, 400));
    assert.match(listed, /\[redacted\]/);
    // A non-text part whose URI puts the key across the 200-character placeholder cut.
    h.nr.respond = request => {
      const body = request.body as { id?: number; method?: string };
      if (body.method !== "tools/call") return undefined;
      const part = { type: "resource", resource: { uri: `${"x".repeat(170)}${FAKE_KEY}` } };
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { content: [part] } } };
    };
    const called = out(await h.call("mcp_call", { tool: "resource_report" }));
    assert.ok(!JSON.stringify(called).includes(KEY_PREFIX), called.text);
  });

  test("UT-160 catalog (R-2): a refresh that failed just before 2×TTL does not let calls through 2 ms after it", async () => {
    await h.call("mcp_tools"); // loaded at t0
    h.nr.respond = request => ((request.body as { method?: string }).method === "tools/list" ? { status: 500 } : undefined);
    h.advance(2 * CATALOG_TTL_MS - 1);
    assert.equal(out(await h.call("mcp_tools")).state, "available", "stale catalog kept inside the grace period");
    h.advance(2);
    const calls = () => h.nr.mcpFake.requests.filter(request => request.method === "tools/call").length;
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), {
      code: "mcp_unavailable",
      message: "New Relic MCP unavailable for this API key (500); use the ext__newrelic__* NerdGraph tools",
    });
    assert.equal(calls(), 0);
    assert.equal(h.mcp.state(h.nr.region), "unavailable");
    assert.ok(RETRY_MS > 2, "the retry throttle is what used to hide the expiry");
  });

  test("UT-160 catalog (R-2): a refresh that crosses 2×TTL while in flight forwards nothing", async () => {
    await h.call("mcp_tools"); // loaded at t0
    h.nr.respond = request => {
      if ((request.body as { method?: string }).method !== "tools/list") return undefined;
      h.advance(2); // the deadline passes while tools/list is in flight
      return { status: 500 };
    };
    h.advance(2 * CATALOG_TTL_MS - 1);
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), {
      code: "mcp_unavailable",
      message: "New Relic MCP unavailable for this API key (500); use the ext__newrelic__* NerdGraph tools",
    });
    assert.equal(h.nr.mcpFake.requests.filter(request => request.method === "tools/call").length, 0);
    assert.equal(h.mcp.state(h.nr.region), "unavailable");
  });

  test("UT-152 learn (R-5): a tools/call 403 without 'requires OAuth' makes the region unavailable and teaches nothing", async () => {
    await h.call("mcp_tools");
    h.nr.respond = request =>
      (request.body as { method?: string }).method === "tools/call" ? { status: 403, body: { error: "account has no MCP access" } } : undefined;
    const message = "New Relic MCP unavailable for this API key (403); use the ext__newrelic__* NerdGraph tools";
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message });
    assert.ok(!h.oauthOnly.has("list_recent_issues"));
    assert.ok(!h.lines.some(line => line.includes("requires OAuth")));
    assert.equal(h.mcp.state(h.nr.region), "unavailable");
    const sent = h.nr.mcpFake.requests.length;
    assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_unavailable", message });
    assert.equal(h.nr.mcpFake.requests.length, sent);
  });

  test("UT-192 redirects (R-4): a 3xx from the MCP or NerdGraph endpoint never sends the key to another origin", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const other = await listen((headers, res) => {
      seen.push(headers);
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    const selected = await listen((_headers, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${other.port}/mcp/` }).end();
    });
    try {
      const region = `loopback:${selected.port}` as const;
      await assert.rejects(createMcpClient(region, FAKE_KEY).listTools(new AbortController().signal), (error: McpError) => {
        assert.deepEqual([error.kind, error.message], ["request_failed", "HTTP 307"]);
        return true;
      });
      await assert.rejects(createNerdGraphClient(region, FAKE_KEY).query("{x}", {}, new AbortController().signal), {
        message: "New Relic request failed: 307",
      });
      assert.deepEqual(seen, [], "the redirect target received no request");
    } finally {
      other.closeAllConnections();
      selected.closeAllConnections();
      await Promise.all([new Promise(r => other.close(r)), new Promise(r => selected.close(r))]);
    }
  });

  test("UT-193 SSE (R-6): an answer event on a stream the server keeps open is read without waiting for EOF", async () => {
    h.nr.mcpFake.mode = "sse";
    h.nr.mcpFake.holdOpen = true;
    const client = createMcpClient(h.nr.region, FAKE_KEY, { timeoutMs: 2_000, callTimeoutMs: 2_000 });
    const started = performance.now();
    const tools = await client.listTools(new AbortController().signal);
    assert.equal(tools.length, h.nr.mcpFake.tools.length);
    const result = await client.callTool("list_recent_issues", { account_id: 1 }, new AbortController().signal);
    assert.deepEqual(result.structuredContent, { tool: "list_recent_issues", arguments: { account_id: 1 } });
    assert.ok(performance.now() - started < 1_500, "no request waited for its timeout");
    h.nr.mcpFake.holdOpen = false;
    h.nr.mcpFake.mode = "json";
    const plain = createMcpClient(h.nr.region, FAKE_KEY, { timeoutMs: 2_000 });
    assert.equal((await plain.listTools(new AbortController().signal)).length, tools.length);
  });
});
