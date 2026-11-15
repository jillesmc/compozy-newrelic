import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { CATALOG_TTL_MS, classify, OAUTH_ONLY_SEED, RETRY_MS } from "../src/mcp-catalog.ts";
import { compactSchema, MAX_ARGUMENT_BYTES, MAX_MCP_TEXT_BYTES } from "../src/tools/mcp-proxy.ts";
import { toolHandler, TOOLS } from "../src/tools/index.ts";
import { FAKE_KEY, out, startProxyHarness, toolFailure } from "./helpers.ts";

const READ = { readOnlyHint: true };
let h: Awaited<ReturnType<typeof startProxyHarness>>;
beforeEach(async () => {
  h = await startProxyHarness();
});
afterEach(async () => {
  await h.nr.close();
});

const UNAVAILABLE = (reason: string) => `New Relic MCP unavailable for this API key (${reason}); use the ext__newrelic__* NerdGraph tools`;

describe("MCP proxy (unit, fake MCP)", () => {
  test("UT-130 catalog: only readOnlyHint:true, non-destructive, non-OAuth tools are exposed; hidden counts", async () => {
    const result = out(await h.call("mcp_tools"));
    assert.equal(result.state, "available");
    assert.equal(result.region, h.nr.region);
    assert.deepEqual(result.exposed.map((row: { name: string }) => row.name), [
      "analyze_transactions",
      "chart_report",
      "execute_nrql_query",
      "get_distributed_trace_details",
      "large_report",
      "list_recent_issues",
      "oauth_gated_report",
    ]);
    assert.deepEqual(result.hidden, { oauth_only: 2, not_read_only: 2 });
    assert.equal(result.truncated, false);
    const seed = new Set<string>(OAUTH_ONLY_SEED);
    const reason = (annotations: unknown, name = "t") => {
      const exposure = classify({ name, annotations } as never, seed);
      return exposure.exposed ? "exposed" : exposure.reason;
    };
    assert.equal(reason(READ), "exposed");
    assert.equal(reason(undefined), "not_read_only");
    assert.equal(reason({ readOnlyHint: "true" }), "not_read_only");
    assert.equal(reason({ readOnlyHint: true, destructiveHint: true }), "not_read_only");
    assert.equal(reason(READ, "search_traces"), "oauth_only");
  });

  test("UT-131 catalog: query is a case-insensitive substring of name or description; limit caps and sets truncated", async () => {
    const names = async (input: Record<string, unknown>) => out(await h.call("mcp_tools", input)).exposed.map((row: { name: string }) => row.name);
    assert.deepEqual(await names({ query: "TRACE" }), ["get_distributed_trace_details"]);
    assert.deepEqual(await names({ query: "Slow" }), ["analyze_transactions"]);
    h.nr.mcpFake.tools = Array.from({ length: 70 }, (_, i) => ({ name: `tool_${String(i).padStart(2, "0")}`, annotations: READ }));
    h.advance(CATALOG_TTL_MS);
    const all = out(await h.call("mcp_tools"));
    assert.deepEqual([all.exposed.length, all.truncated], [60, true]);
    const two = out(await h.call("mcp_tools", { limit: 2, query: "tool_6" }));
    assert.deepEqual([two.exposed.map((row: { name: string }) => row.name), two.truncated], [["tool_60", "tool_61"], true]);
    assert.equal(out(await h.call("mcp_tools", { query: "tool_69" })).truncated, false);
    assert.equal((await toolFailure(h.call("mcp_tools", { limit: 61 }))).code, "params_invalid");
  });

  test("UT-132 catalog: input schemas compact to prop: type — description (≤ 80 chars); descriptions ≤ 200 chars", async () => {
    const long = "word ".repeat(40);
    assert.deepEqual(
      compactSchema({
        type: "object",
        properties: { a: { type: "string", description: long }, b: { type: ["string", "null"] }, c: { description: "free\nform" } },
      }),
      { a: `string — ${"word ".repeat(15)}word…`, b: "string|null", c: "any — free form" }
    );
    assert.equal(Array.from(compactSchema({ properties: { a: { type: "string", description: long } } }).a!.split(" — ")[1]!).length, 80);
    assert.deepEqual(compactSchema(undefined), {});
    h.nr.mcpFake.tools = [{ name: "wide", description: `multi\nline ${"d".repeat(300)}`, annotations: READ }];
    const row = out(await h.call("mcp_tools")).exposed[0];
    assert.equal(Array.from(row.description as string).length, 200);
    assert.doesNotMatch(row.description, /\n/);
    assert.deepEqual(row.input, {});
  });

  test("UT-140 call: text parts are joined, non-text parts become placeholders, text capped at 16 KiB with truncated", async () => {
    const chart = out(await h.call("mcp_call", { tool: "chart_report" }));
    assert.deepEqual(chart, { tool: "chart_report", is_error: false, text: "chart below\n[image content omitted: image/png]", truncated: false });
    const big = await h.call("mcp_call", { tool: "large_report" });
    const result = out(big);
    assert.equal(result.truncated, true);
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(result.text) <= MAX_MCP_TEXT_BYTES);
    assert.ok(Buffer.byteLength(result.text) > MAX_MCP_TEXT_BYTES - 8);
    assert.equal(big.content?.[0]?.text, result.text);
    assert.equal(result.structured, undefined, "20 KiB structuredContent is dropped");
  });

  test("UT-141 call: structuredContent up to 16 KiB passes through; one byte more is replaced by the text", async () => {
    // The fake's ok behavior answers structuredContent {tool, arguments} and the same JSON as text.
    const overhead = JSON.stringify({ tool: "list_recent_issues", arguments: { pad: "" } }).length;
    const exact = out(await h.call("mcp_call", { tool: "list_recent_issues", arguments: { pad: "x".repeat(MAX_MCP_TEXT_BYTES - overhead) } }));
    assert.equal(exact.truncated, false);
    assert.equal(JSON.stringify(exact.structured).length, MAX_MCP_TEXT_BYTES);
    const over = out(await h.call("mcp_call", { tool: "list_recent_issues", arguments: { pad: "x".repeat(MAX_MCP_TEXT_BYTES - overhead + 1) } }));
    assert.equal(over.truncated, true);
    assert.equal(over.structured, undefined);
    assert.ok(Buffer.byteLength(over.text) <= MAX_MCP_TEXT_BYTES);
  });

  test("UT-142 call: arguments over 64 KiB are refused locally with no request", async () => {
    const failure = await toolFailure(h.call("mcp_call", { tool: "list_recent_issues", arguments: { pad: "x".repeat(MAX_ARGUMENT_BYTES) } }));
    assert.deepEqual(failure, { code: "params_invalid", message: "arguments exceed 64 KiB; send a smaller request" });
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "x", arguments: [1] }))).code, "params_invalid");
    assert.equal(h.fetches(), 0);
  });

  test("UT-150 call: a seeded OAuth-only tool is refused as oauth_only with zero fetch calls", async () => {
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "natural_language_to_nrql_query" })), {
      code: "mcp_tool_not_exposed",
      reason: "oauth_only",
      message: "natural_language_to_nrql_query requires OAuth; sign in with compozy mcp auth login newrelic or use another tool",
    });
    const eu = await toolFailure(h.call("mcp_call", { tool: "search_traces", region: "eu" }));
    assert.match(eu.message, /compozy mcp auth login newrelic-eu/);
    assert.equal(h.fetches(), 0);
  });

  test("UT-151 call: unannotated or destructive tools are refused as not_read_only; unknown tools as unknown_tool", async () => {
    await h.call("mcp_tools");
    const before = h.fetches();
    for (const tool of ["delete_dashboard", "create_change_event"]) {
      assert.deepEqual(await toolFailure(h.call("mcp_call", { tool })), {
        code: "mcp_tool_not_exposed",
        reason: "not_read_only",
        message: `${tool} is not marked read-only by New Relic; the proxy does not call it`,
      });
    }
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "no_such_tool" })), {
      code: "mcp_tool_not_exposed",
      reason: "unknown_tool",
      message: `no_such_tool is not in the New Relic MCP catalog for region ${h.nr.region}`,
    });
    assert.equal(h.fetches(), before);
    assert.ok(!h.nr.mcpFake.requests.some(request => request.method === "tools/call"));
  });

  test("UT-152 catalog: learnOAuthOnly hides the tool, blocks the next call, and logs one stderr line", async () => {
    await h.call("mcp_tools");
    h.mcp.learnOAuthOnly("list_recent_issues");
    h.mcp.learnOAuthOnly("list_recent_issues");
    assert.deepEqual(h.lines.slice(1), ["newrelic: mcp tool list_recent_issues requires OAuth; hidden\n"]);
    const listed = out(await h.call("mcp_tools"));
    assert.ok(!listed.exposed.some((row: { name: string }) => row.name === "list_recent_issues"));
    assert.equal(listed.hidden.oauth_only, 3);
    const before = h.fetches();
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" }))).reason, "oauth_only");
    assert.equal(h.fetches(), before);
  });

  test("UT-160 catalog: TTL expiry refreshes; a failed refresh keeps the old catalog at most one more TTL, then unavailable", async () => {
    await h.call("mcp_tools");
    const added = { name: "list_dashboards", annotations: READ };
    h.nr.mcpFake.tools.push(added);
    h.advance(CATALOG_TTL_MS - 1);
    const cached = h.fetches();
    assert.equal(out(await h.call("mcp_tools", { query: "dashboards" })).exposed.length, 0);
    assert.equal(h.fetches(), cached);
    h.advance(1);
    assert.equal(out(await h.call("mcp_tools", { query: "dashboards" })).exposed.length, 1); // refreshed at T
    h.nr.mcpFake.status = 500;
    h.advance(CATALOG_TTL_MS);
    assert.equal(out(await h.call("mcp_tools", { query: "dashboards" })).exposed.length, 1, "stale catalog kept");
    const failed = h.fetches();
    h.advance(RETRY_MS - 1);
    await h.call("mcp_tools");
    assert.equal(h.fetches(), failed, "failed refreshes are retried at most once per minute");
    h.advance(CATALOG_TTL_MS - RETRY_MS + 1); // T + 2 TTL
    assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_request_failed", message: "HTTP 500" });
    assert.equal(h.mcp.state(h.nr.region), "unavailable");
    assert.deepEqual(h.lines, [`newrelic: region=${h.nr.region} mcp=available\n`, `newrelic: region=${h.nr.region} mcp=unavailable(500)\n`]);
    const unavailable = h.fetches();
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message: UNAVAILABLE("500") });
    assert.equal(h.fetches(), unavailable);
  });

  test("UT-170 state: a probe 403 makes both tools answer mcp_unavailable with zero fetch calls after the probe", async () => {
    h.nr.mcpFake.initStatus = 403;
    assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_unavailable", message: UNAVAILABLE("403") });
    const probed = h.fetches();
    assert.equal(probed, 1);
    assert.deepEqual(await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" })), { code: "mcp_unavailable", message: UNAVAILABLE("403") });
    assert.equal((await toolFailure(h.call("mcp_tools", { query: "x" }))).code, "mcp_unavailable");
    assert.equal(h.fetches(), probed);
    assert.deepEqual(h.lines, [`newrelic: region=${h.nr.region} mcp=unavailable(403)\n`]);
  });

  test("UT-171 state: unknown is re-probed at most once per minute", async () => {
    h.nr.mcpFake.status = 503;
    assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_request_failed", message: "HTTP 503" });
    assert.equal(h.mcp.state(h.nr.region), "unknown");
    const probed = h.fetches();
    h.advance(RETRY_MS - 1);
    assert.deepEqual(await toolFailure(h.call("mcp_tools")), { code: "mcp_unavailable", message: UNAVAILABLE("503") });
    assert.equal((await toolFailure(h.call("mcp_call", { tool: "list_recent_issues" }))).code, "mcp_unavailable");
    assert.equal(h.fetches(), probed);
    h.nr.mcpFake.status = 0;
    h.advance(1);
    assert.equal(out(await h.call("mcp_tools")).state, "available");
    assert.ok(h.fetches() > probed);
    assert.deepEqual(h.lines, [`newrelic: region=${h.nr.region} mcp=available\n`]);
  });

  test("UT-190 redaction: a key echoed in remote text, structured content or a remote error is redacted", async () => {
    h.nr.mcpFake.tools.push({ name: "echo_key", annotations: READ, behavior: "echo_key" });
    const echoed = await h.call("mcp_call", { tool: "echo_key" });
    assert.deepEqual(out(echoed), { tool: "echo_key", is_error: false, text: "your key is [redacted]", structured: { key: "[redacted]" }, truncated: false });
    const remoteError = await h.call("mcp_call", { tool: "execute_nrql_query", arguments: { nrql: FAKE_KEY } });
    assert.equal(out(remoteError).is_error, true);
    h.nr.mcpFake.tools.push({ name: `rpc_${FAKE_KEY}`, annotations: READ, behavior: "rpc_error" });
    h.advance(CATALOG_TTL_MS);
    const rpc = await h.call("mcp_call", { tool: `rpc_${FAKE_KEY}` });
    assert.deepEqual(out(rpc), { tool: "rpc_[redacted]", is_error: true, text: "bad params for rpc_[redacted]", truncated: false });
    const listed = JSON.stringify(await h.call("mcp_tools"));
    for (const text of [JSON.stringify(echoed), JSON.stringify(remoteError), JSON.stringify(rpc), listed, h.lines.join("")]) {
      assert.ok(!text.includes(FAKE_KEY));
    }
  });
  test("UT-191 tool errors: data is a CompozyOS ToolError {code: tool_*, message: '<extension code>: ...'} (D-18)", async () => {
    const data = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const rpc = error as { message: string; data: unknown };
        assert.equal(rpc.message, (rpc.data as { message: string }).message);
        return rpc.data;
      }
      throw new Error("expected a tool error");
    };
    // (a) an mcp_call oauth_only refusal (UT-150 tool error data)
    assert.deepEqual(await data(h.call("mcp_call", { tool: "natural_language_to_nrql_query" })), {
      code: "tool_denied",
      message:
        "mcp_tool_not_exposed (oauth_only): natural_language_to_nrql_query requires OAuth; sign in with compozy mcp auth login newrelic or use another tool",
    });
    // (c) a params error and a v0.1 tool without a key
    assert.deepEqual(await data(h.call("mcp_tools", { limit: 61 })), {
      code: "tool_invalid_input",
      message: "params_invalid: limit must be an integer from 1 to 60",
    });
    const noKey = toolHandler(TOOLS.find(tool => tool.name === "nrql_query")!, { env: {} });
    assert.deepEqual(await data(Promise.resolve(noKey({ input: { account_id: 1, nrql: "SELECT 1" } } as never))), {
      code: "tool_unavailable",
      message: "credential_absent: New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY",
    });
    // (d) mcp_request_failed on the probe, then (b) mcp_unavailable within the retry minute
    h.nr.mcpFake.status = 502;
    assert.deepEqual(await data(h.call("mcp_tools")), { code: "tool_backend_failed", message: "mcp_request_failed: HTTP 502" });
    assert.deepEqual(await data(h.call("mcp_call", { tool: "list_recent_issues" })), {
      code: "tool_unavailable",
      message: "mcp_unavailable: New Relic MCP unavailable for this API key (502); use the ext__newrelic__* NerdGraph tools",
    });
    assert.equal(h.nr.mcpFake.requests.length, 1);
    // a v0.1 network failure stays a backend failure with its message
    const down = toolHandler(TOOLS.find(tool => tool.name === "nrql_query")!, { env: { NEW_RELIC_API_KEY: FAKE_KEY } });
    assert.deepEqual(await data(Promise.resolve(down({ input: { account_id: 1, nrql: "SELECT 1", region: "loopback:9" } } as never))), {
      code: "tool_backend_failed",
      message: "extension_failed: New Relic request failed: network error",
    });
  });
});
