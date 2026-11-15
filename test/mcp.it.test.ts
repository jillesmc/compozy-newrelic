import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { CATALOG_TTL_MS } from "../src/mcp-catalog.ts";
import { createMcpClient, McpError } from "../src/mcp-client.ts";
import { FAKE_KEY, out, startProxyHarness, toolFailure } from "./helpers.ts";

let h: Awaited<ReturnType<typeof startProxyHarness>>;
beforeEach(async () => {
  h = await startProxyHarness();
});
afterEach(async () => {
  await h.nr.close();
});

const methods = () => h.nr.mcpFake.requests.map(request => request.method);

/** IT-102/IT-103: the same calls in either answer mode. */
async function assertCalls(): Promise<void> {
  const ok = out(await h.call("mcp_call", { tool: "list_recent_issues", arguments: { account_id: 1234567 } }));
  assert.deepEqual(ok, {
    tool: "list_recent_issues",
    is_error: false,
    text: '{"tool":"list_recent_issues","arguments":{"account_id":1234567}}',
    structured: { tool: "list_recent_issues", arguments: { account_id: 1234567 } },
    truncated: false,
  });
  const remote = out(await h.call("mcp_call", { tool: "execute_nrql_query", arguments: { bad: true } }));
  assert.deepEqual(remote, { tool: "execute_nrql_query", is_error: true, text: 'invalid arguments for execute_nrql_query: {"bad":true}', truncated: false });
  const call = h.nr.mcpFake.requests.find(request => request.method === "tools/call");
  assert.deepEqual(call?.params, { name: "list_recent_issues", arguments: { account_id: 1234567 } });
}

describe("MCP proxy against the fake Streamable HTTP MCP", () => {
  test("IT-101 catalog: initialize, notifications/initialized and two tools/list pages merge into the filtered catalog", async () => {
    h.nr.mcpFake.pageSize = 6; // 11 tools → 2 pages
    const listed = out(await h.call("mcp_tools"));
    assert.equal(listed.exposed.length, 7);
    assert.ok(listed.exposed.some((row: { name: string }) => row.name === "oauth_gated_report"), "page 2 merged");
    assert.deepEqual(methods(), ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    const [init, ...rest] = h.nr.mcpFake.requests;
    assert.equal(init!.headers["mcp-session-id"], undefined);
    assert.deepEqual(rest.map(request => request.headers["mcp-session-id"]), Array(3).fill([...h.nr.mcpFake.sessions][0]));
    assert.ok(h.nr.mcpFake.requests.every(request => request.headers["api-key"] === FAKE_KEY));
    assert.ok(rest.every(request => request.headers["mcp-protocol-version"] === "2025-06-18"));
    assert.ok(/text\/event-stream/.test(String(init!.headers.accept)));
    assert.deepEqual(rest.map(request => request.params?.cursor), [undefined, undefined, "6"]);
  });

  test("IT-102 call: tools/call returns the result in JSON mode; a remote tool error is is_error true", async () => {
    await assertCalls();
    h.nr.mcpFake.tools.push({ name: "bad_params", annotations: { readOnlyHint: true }, behavior: "rpc_error" });
    h.advance(CATALOG_TTL_MS);
    assert.deepEqual(out(await h.call("mcp_call", { tool: "bad_params" })), { tool: "bad_params", is_error: true, text: "bad params for bad_params", truncated: false });
  });

  test("IT-102 call: 401, 429, 5xx and timeouts map to credential_expired, rate_limited and mcp_request_failed", async () => {
    await h.call("mcp_tools");
    const failure = async (status: number) => {
      h.nr.mcpFake.status = status;
      return await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" }));
    };
    assert.equal((await failure(401)).code, "credential_expired");
    assert.equal((await failure(429)).code, "rate_limited");
    assert.deepEqual(await failure(502), { code: "mcp_request_failed", message: "HTTP 502" });
    h.nr.mcpFake.status = 0;
    const client = createMcpClient(h.nr.region, FAKE_KEY, { callTimeoutMs: 50 });
    await assert.rejects(client.callTool("analyze_transactions", {}, new AbortController().signal), (error: McpError) => {
      assert.deepEqual([error.kind, error.message], ["request_failed", "no answer within 0.05s"]);
      return true;
    });
  });

  test("IT-103 call: tools/call returns the result in SSE mode (one data: event)", async () => {
    h.nr.mcpFake.mode = "sse";
    assert.equal(out(await h.call("mcp_tools")).exposed.length, 7);
    await assertCalls();
  });

  test("IT-104 session: an expired session (404) is re-initialized once and the call succeeds; twice fails", async () => {
    await h.call("mcp_tools");
    h.nr.mcpFake.expireCalls = 1;
    assert.equal(out(await h.call("mcp_call", { tool: "chart_report" })).is_error, false);
    assert.deepEqual(methods().slice(3), ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
    h.nr.mcpFake.expireCalls = 2;
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "chart_report" })), {
      code: "mcp_request_failed",
      message: "session expired twice",
    });
    assert.equal(methods().filter(method => method === "initialize").length, 3);
  });

  test("IT-104 session: an initialize 403 on a re-handshake makes the region unavailable; nothing more is sent (R-5)", async () => {
    await h.call("mcp_tools");
    h.nr.mcpFake.expireCalls = 1;
    h.nr.mcpFake.initStatus = 403;
    const message = "New Relic MCP unavailable for this API key (403); use the ext__newrelic__* NerdGraph tools";
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message });
    assert.equal(h.mcp.state(h.nr.region), "unavailable");
    assert.ok(h.lines.includes(`newrelic: region=${h.nr.region} mcp=unavailable(403)\n`));
    const sent = h.nr.mcpFake.requests.length;
    assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_unavailable", message });
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message });
    assert.equal(h.nr.mcpFake.requests.length, sent);
    h.nr.mcpFake.initStatus = 0;
    h.advance(CATALOG_TTL_MS); // re-probed after one TTL
    assert.equal(out(await h.call("mcp_call", { tool: "list_recent_issues" })).is_error, false);
  });

  test("IT-105 learn: a tool answering 403 requires OAuth is learned and never listed or forwarded again", async () => {
    assert.ok(out(await h.call("mcp_tools")).exposed.some((row: { name: string }) => row.name === "oauth_gated_report"));
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "oauth_gated_report" })), {
      code: "mcp_tool_not_exposed",
      reason: "oauth_only",
      message: "oauth_gated_report requires OAuth; sign in with compozy mcp auth login newrelic or use another tool",
    });
    assert.ok(h.lines.includes("newrelic: mcp tool oauth_gated_report requires OAuth; hidden\n"));
    const listed = out(await h.call("mcp_tools"));
    assert.ok(!listed.exposed.some((row: { name: string }) => row.name === "oauth_gated_report"));
    assert.equal(listed.hidden.oauth_only, 3);
    const calls = methods().filter(method => method === "tools/call").length;
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "oauth_gated_report" }))).reason, "oauth_only");
    assert.equal(methods().filter(method => method === "tools/call").length, calls);
    // Deviation D-12: a tool result with isError and "requires OAuth" text is learned the same way.
    h.nr.respond = request => {
      const body = request.body as { id?: number; method?: string; params?: { name?: string } };
      if (body.method !== "tools/call" || body.params?.name !== "chart_report") return undefined;
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "This tool requires OAuth authentication" }], isError: true } } };
    };
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "chart_report" }))).reason, "oauth_only");
    assert.ok(h.lines.includes("newrelic: mcp tool chart_report requires OAuth; hidden\n"));
    // A forbidden body echoing the key never surfaces (UT-190 at the client).
    h.nr.respond = request => (request.path === "/mcp/" && (request.body as { method?: string }).method === "tools/call" ? { status: 403, body: `no ${FAKE_KEY}` } : undefined);
    const client = createMcpClient(h.nr.region, FAKE_KEY);
    await assert.rejects(client.callTool("x", {}, new AbortController().signal), (error: McpError) => error.kind === "forbidden" && error.message === "no [redacted]");
  });

  test("IT-106 catalog: an added tool is listed and callable after the TTL; a removed one becomes unknown_tool", async () => {
    await h.call("mcp_tools");
    h.nr.mcpFake.tools.push({ name: "list_dashboards", description: "List dashboards.", annotations: { readOnlyHint: true } });
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "list_dashboards" }))).reason, "unknown_tool");
    h.advance(CATALOG_TTL_MS);
    assert.deepEqual(out(await h.call("mcp_tools", { query: "dashboards" })).exposed.map((row: { name: string }) => row.name), ["list_dashboards"]);
    assert.equal(out(await h.call("mcp_call", { tool: "list_dashboards" })).is_error, false);
    h.nr.mcpFake.tools = h.nr.mcpFake.tools.filter(tool => tool.name !== "list_dashboards");
    h.advance(CATALOG_TTL_MS);
    assert.equal(out(await h.call("mcp_tools", { query: "dashboards" })).exposed.length, 0);
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "list_dashboards" }))).reason, "unknown_tool");
  });

  test("IT-107 unavailable: a doctor 403/404 on a warm catalog is authoritative; nothing is forwarded or learned (R-5)", async () => {
    for (const status of [403, 404]) {
      await h.nr.close();
      h = await startProxyHarness();
      h.nr.respond = request => (request.path === "/graphql" ? { status: 200, body: { data: { actor: { accounts: [{ id: 1 }] } } } } : undefined);
      assert.equal(out(await h.call("mcp_tools")).exposed.length, 7);
      h.nr.mcpFake.status = status;
      assert.match(String(await h.call("doctor")), new RegExp(`^MCP: unavailable \\(${status} from `, "m"));
      assert.equal(h.mcp.state(h.nr.region), "unavailable");
      const sent = h.nr.mcpFake.requests.length;
      const message = `New Relic MCP unavailable for this API key (${status}); use the ext__newrelic__* NerdGraph tools`;
      assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_unavailable", message });
      assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message });
      assert.equal(h.nr.mcpFake.requests.length, sent);
      assert.ok(!h.oauthOnly.has("list_recent_issues"));
    }
  });

  test("IT-107 unavailable: initialize 404 or 403 → the doctor prints unavailable and both tools return mcp_unavailable with no further request", async () => {
    for (const status of [404, 403]) {
      await h.nr.close();
      h = await startProxyHarness();
      h.nr.respond = request => (request.path === "/graphql" ? { status: 200, body: { data: { actor: { accounts: [{ id: 1 }] } } } } : undefined);
      h.nr.mcpFake.initStatus = status;
      assert.match(
        String(await h.call("doctor")),
        new RegExp(`^MCP: unavailable \\(${status} from http://127\\.0\\.0\\.1:${h.nr.port}/mcp/\\) — agents keep the ext__newrelic__\\* tools`, "m")
      );
      const message = `New Relic MCP unavailable for this API key (${status}); use the ext__newrelic__* NerdGraph tools`;
      // R-5: the doctor's probe is the proxy's region state; the next proxy calls send no request.
      assert.equal(h.mcp.state(h.nr.region), "unavailable");
      const probes = h.fetches();
      assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_unavailable", message });
      assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message });
      assert.equal(h.fetches(), probes);
    }
  });
});
