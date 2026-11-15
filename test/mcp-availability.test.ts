import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { CATALOG_TTL_MS, RETRY_MS } from "../src/mcp-catalog.ts";
import { createMcpClient, McpError } from "../src/mcp-client.ts";
import { FAKE_KEY, out, startProxyHarness, toolFailure } from "./helpers.ts";

/** Region availability transitions promised by D-19 and the README (review rounds 2–3, R-5 and R-7). */
let h: Awaited<ReturnType<typeof startProxyHarness>>;
beforeEach(async () => {
  h = await startProxyHarness();
});
afterEach(async () => {
  await h.nr.close();
});

const ACCOUNTS = { status: 200, body: { data: { actor: { accounts: [{ id: 1 }] } } } };
const unavailable = (reason: string) => `New Relic MCP unavailable for this API key (${reason}); use the ext__newrelic__* NerdGraph tools`;
const method = (request: { body: unknown }) => (request.body as { method?: string }).method;
const mcpRequests = () => h.nr.mcpFake.requests.length;

describe("MCP region availability", () => {
  test("UT-170 state (R-5): a doctor that joins an in-flight refresh keeps its authority; a transient failure makes the region unknown", async () => {
    await h.call("mcp_tools");
    h.advance(CATALOG_TTL_MS);
    let doctor: Promise<unknown> | undefined;
    h.nr.respond = request => {
      if (request.path === "/graphql") return ACCOUNTS;
      if (method(request) !== "tools/list") return undefined;
      doctor ??= h.call("doctor"); // joins the proxy's refresh while tools/list is in flight
      return { status: 500 };
    };
    await h.call("mcp_tools").catch(() => undefined);
    assert.match(String(await doctor), /^MCP: unknown \(HTTP 500\)/m);
    assert.equal(h.mcp.state(h.nr.region), "unknown");
    const sent = mcpRequests();
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message: unavailable("500") });
    assert.equal(mcpRequests(), sent);
    h.nr.respond = undefined;
    h.advance(RETRY_MS); // unknown is re-probed within a minute
    assert.equal(out(await h.call("mcp_tools")).state, "available");
  });

  test("UT-172 state (R-7): a tools/list 404, 403 or 401 on a warm catalog is never graced; re-probed after one TTL", async () => {
    for (const status of [404, 403, 401]) {
      await h.nr.close();
      h = await startProxyHarness();
      await h.call("mcp_tools");
      h.advance(CATALOG_TTL_MS);
      h.nr.respond = request => (method(request) === "tools/list" ? { status, body: "refused" } : undefined);
      const first = await toolFailure(h.call("mcp_tools"));
      if (status === 401) assert.equal(first.code, "credential_expired");
      else assert.deepEqual(first, { code: "mcp_unavailable", message: unavailable(String(status)) });
      assert.equal(h.mcp.state(h.nr.region), "unavailable", String(status));
      assert.ok(h.lines.includes(`newrelic: region=${h.nr.region} mcp=unavailable(${status})\n`));
      const sent = mcpRequests();
      assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message: unavailable(String(status)) });
      h.advance(CATALOG_TTL_MS - 1);
      assert.equal((await toolFailure(h.call("mcp_tools"))).code, "mcp_unavailable");
      assert.equal(mcpRequests(), sent, "nothing forwarded or re-probed before one TTL");
      h.nr.respond = undefined;
      h.advance(1);
      assert.equal(out(await h.call("mcp_tools")).state, "available");
    }
  });

  test("UT-172 state (R-7): a stateless 404 (no session) is a refusal, not an expiry", async () => {
    h.nr.respond = request => {
      const body = request.body as { id?: number; method?: string };
      if (body.method === "initialize") {
        return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } } };
      }
      return body.method === "notifications/initialized" ? { status: 202 } : { status: 404, body: "not found" };
    };
    await assert.rejects(createMcpClient(h.nr.region, FAKE_KEY).listTools(new AbortController().signal), (error: McpError) => {
      assert.deepEqual([error.kind, error.status], ["unavailable", 404]);
      return true;
    });
  });

  test("IT-107 doctor (D-19.1): a doctor available loads the shared catalog; the next mcp_tools sends no request", async () => {
    h.nr.respond = request => (request.path === "/graphql" ? ACCOUNTS : undefined);
    assert.match(String(await h.call("doctor")), /^MCP: available \(7 tools exposed via API key; 2 OAuth-only hidden\)/m);
    assert.equal(h.mcp.state(h.nr.region), "available");
    const sent = mcpRequests();
    assert.equal(out(await h.call("mcp_tools")).exposed.length, 7);
    assert.equal(mcpRequests(), sent);
    assert.deepEqual(h.lines, [], "the probe writes no state-change line");
  });
});
