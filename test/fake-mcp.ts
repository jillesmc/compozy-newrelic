/**
 * Fake official New Relic MCP (Streamable HTTP) served by the fake NerdGraph at `POST /mcp/`, so
 * `region: loopback:<port>` reaches both. It issues and checks `Mcp-Session-Id`, pages `tools/list`
 * by `nextCursor`, answers in JSON or SSE, and runs per-tool behaviors.
 *
 * In-process: `nr.mcpFake` is the live state (mode, tools, pageSize, initStatus, status, expireCalls,
 * requests). Standalone: `POST /_fake/mcp` with any of those fields (JSON) changes it; `GET` reads it.
 */
import type { IncomingHttpHeaders, ServerResponse } from "node:http";

export type FakeToolBehavior = "ok" | "error" | "rpc_error" | "oauth" | "slow" | "big" | "echo_key" | "image" | "json_differs";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** Default `ok`: text plus `structuredContent` echoing the arguments. */
  behavior?: FakeToolBehavior;
  /** `slow` holds the answer this long (default 2000 ms). */
  delayMs?: number;
}

export interface FakeMcpRequest {
  method: string;
  headers: IncomingHttpHeaders;
  params?: Record<string, unknown>;
}

export interface FakeMcp {
  mode: "json" | "sse";
  tools: FakeTool[];
  pageSize: number;
  /** `initialize` answers this HTTP status (403/404: no MCP for the key; 401, 429, 5xx). */
  initStatus?: number;
  /** Every MCP request answers this HTTP status. */
  status?: number;
  /** The next `expireCalls` tools/call requests find their session expired (404). */
  expireCalls: number;
  /** SSE answers stay open after the event (a server that never ends the stream). */
  holdOpen?: boolean;
  sessions: Set<string>;
  requests: FakeMcpRequest[];
}

const READ = { readOnlyHint: true } as const;
const schema = (properties: Record<string, unknown>) => ({ type: "object", properties });

/** A catalog like the real one: read-only tools, the two seeded OAuth-only tools, and unsafe ones. */
export function defaultFakeTools(): FakeTool[] {
  return [
    { name: "list_recent_issues", description: "List recent New Relic issues of an account.", annotations: READ, inputSchema: schema({ account_id: { type: "integer", description: "New Relic account id" } }) },
    {
      name: "get_distributed_trace_details",
      description: "See the complete execution path of a single request across every service it touched.",
      annotations: READ,
      inputSchema: schema({ trace_id: { type: "string", description: "trace id" }, timestamp: { type: "integer", description: "root span start (ms)" } }),
    },
    { name: "analyze_transactions", description: "Analyze slow transactions.", annotations: READ, behavior: "slow", delayMs: 1500 },
    { name: "execute_nrql_query", description: "Run NRQL.", annotations: READ, behavior: "error" },
    { name: "large_report", description: "Returns more than 16 KiB.", annotations: READ, behavior: "big" },
    { name: "chart_report", description: "Returns text plus an image.", annotations: READ, behavior: "image" },
    { name: "oauth_gated_report", description: "Read-only but answers 403 requires OAuth.", annotations: READ, behavior: "oauth" },
    { name: "natural_language_to_nrql_query", description: "Translate a question to NRQL.", annotations: READ, behavior: "oauth" },
    { name: "search_traces", description: "Search traces.", annotations: READ, behavior: "oauth" },
    { name: "delete_dashboard", description: "Delete a dashboard.", annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: "create_change_event", description: "Record a change event (no annotations)." },
  ];
}

export function createFakeMcp(): FakeMcp {
  return { mode: "json", tools: defaultFakeTools(), pageSize: 50, expireCalls: 0, sessions: new Set(), requests: [] };
}

/** Applies a standalone `/_fake/mcp` update. */
export function configureFakeMcp(mcp: FakeMcp, update: Partial<Omit<FakeMcp, "sessions" | "requests">>): void {
  Object.assign(mcp, update);
}

type Wait = (ms: number) => Promise<void>;
let sessionCounter = 0;

export async function answerMcp(mcp: FakeMcp, headers: IncomingHttpHeaders, raw: string, res: ServerResponse, wait: Wait): Promise<void> {
  const send = (status: number, body?: unknown, extra: Record<string, string> = {}) => {
    if (res.destroyed) return;
    if (body === undefined) {
      res.writeHead(status, extra);
      return void res.end();
    }
    const text = JSON.stringify(body);
    if (mcp.mode === "sse" && status === 200) {
      res.writeHead(200, { "Content-Type": "text/event-stream", ...extra });
      if (mcp.holdOpen) return void res.write(`event: message\ndata: ${text}\n\n`);
      return void res.end(`event: message\ndata: ${text}\n\n`);
    }
    res.writeHead(status, { "Content-Type": "application/json", ...extra });
    res.end(text);
  };
  let message: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(raw || "{}");
  } catch {
    return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
  }
  const method = String(message.method ?? "");
  mcp.requests.push({ method, headers, params: message.params });
  const apiKey = String(headers["api-key"] ?? "");
  if (!/^NRAK-\S+$/.test(apiKey)) return send(401, { error: "unauthorized" });
  if (mcp.status) return send(mcp.status, { error: `fake status ${mcp.status}` });
  const ok = (result: unknown, extra?: Record<string, string>) => send(200, { jsonrpc: "2.0", id: message.id, result }, extra);
  if (method === "initialize") {
    if (mcp.initStatus) return send(mcp.initStatus, { error: `fake initialize ${mcp.initStatus}` });
    const session = `fake-session-${++sessionCounter}`;
    mcp.sessions.add(session);
    const result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-newrelic-mcp", version: "0" } };
    return ok(result, { "Mcp-Session-Id": session });
  }
  const session = String(headers["mcp-session-id"] ?? "");
  if (!session) return send(400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" } });
  if (method === "tools/call" && mcp.expireCalls > 0) {
    mcp.expireCalls--;
    mcp.sessions.clear();
  }
  if (!mcp.sessions.has(session)) return send(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } });
  if (method === "notifications/initialized") return send(202);
  if (method === "tools/list") {
    const offset = Number(message.params?.cursor ?? 0);
    const end = offset + mcp.pageSize;
    const tools = mcp.tools.map(({ behavior: _b, delayMs: _d, ...def }) => def).slice(offset, end);
    return ok({ tools, ...(end < mcp.tools.length ? { nextCursor: String(end) } : {}) });
  }
  if (method !== "tools/call") return send(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  const name = String(message.params?.name ?? "");
  const args = message.params?.arguments ?? {};
  const tool = mcp.tools.find(entry => entry.name === name);
  if (!tool) return send(200, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  const text = (value: string) => ({ type: "text", text: value });
  switch (tool.behavior ?? "ok") {
    case "error":
      return ok({ content: [text(`invalid arguments for ${name}: ${JSON.stringify(args)}`)], isError: true });
    case "rpc_error":
      return send(200, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `bad params for ${name}` } });
    case "oauth":
      return send(403, { error: `Tool ${name} requires OAuth authentication` });
    case "big":
      return ok({ content: [text("x".repeat(40 * 1024))], structuredContent: { blob: "y".repeat(20 * 1024) } });
    case "json_differs":
      return ok({ content: [text('{"rows":1}')], structuredContent: { rows: 2 } });
    case "echo_key":
      return ok({ content: [text(`your key is ${apiKey}`)], structuredContent: { key: apiKey } });
    case "image":
      return ok({ content: [text("chart below"), { type: "image", data: "AAAA", mimeType: "image/png" }] });
    case "slow":
      await wait(tool.delayMs ?? 2000);
      return ok({ content: [text(`${name} done`)] });
    default:
      return ok({ content: [text(JSON.stringify({ tool: name, arguments: args }))], structuredContent: { tool: name, arguments: args } });
  }
}
