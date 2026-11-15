import { redactor } from "./items.ts";
import { REJECTED_KEY_MESSAGE, regionEndpoints, type Region } from "./nerdgraph.ts";

/**
 * Minimal Streamable HTTP MCP client for the official New Relic MCP (spec Core Interfaces): lazy
 * `initialize` + `notifications/initialized`, `Mcp-Session-Id` echo, JSON or SSE answers, `tools/list`
 * paging and `tools/call`. The API key travels only in the `api-key` header (Business Rule 7); every
 * remote text in an error is redacted.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Business Rule 10: handshake and listing requests. */
export const MCP_REQUEST_TIMEOUT_MS = 10_000;
/** Business Rule 10: `tools/call`, because New Relic analyses can be slow. */
export const MCP_CALL_TIMEOUT_MS = 60_000;
const MAX_PAGES = 50;
const MAX_ERROR_CHARS = 1000;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClient {
  /** Every tool, all `nextCursor` pages merged. */
  listTools(signal: AbortSignal): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
}

export interface McpClientOptions {
  fetch?: typeof fetch;
  /** Per-request timeout for the handshake and `tools/list`; defaults to 10 s. */
  timeoutMs?: number;
  /** `tools/call` timeout; defaults to 60 s. */
  callTimeoutMs?: number;
}

/**
 * `unavailable`: initialize answered 403/404 (no MCP for this key). `forbidden`: any other 403 (its
 * redacted body is the message). `rpc`: a JSON-RPC error (redacted message).
 */
export type McpErrorKind = "unavailable" | "forbidden" | "credential_expired" | "rate_limited" | "request_failed" | "rpc";

export class McpError extends Error {
  readonly kind: McpErrorKind;
  readonly status: number | undefined;
  public constructor(kind: McpErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

interface RpcMessage {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
}

interface Answer {
  status: number;
  text: string;
  sessionId: string | undefined;
}

export function createMcpClient(region: Region, apiKey: string, options: McpClientOptions = {}): McpClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const url = regionEndpoints(region).mcp;
  const redact = redactor(apiKey);
  const clip = (text: string) => redact(text).slice(0, MAX_ERROR_CHARS);
  let nextId = 1;
  /** Shared handshake; resolves to the session id (undefined for a stateless server). */
  let session: Promise<string | undefined> | undefined;

  async function post(message: Record<string, unknown>, sessionId: string | undefined, limitMs: number, signal: AbortSignal): Promise<Answer> {
    const timeout = AbortSignal.timeout(limitMs);
    const headers: Record<string, string> = {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (message.method !== "initialize") headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...message }),
        signal: AbortSignal.any([signal, timeout]),
        // Never resend the key to a redirect target; a 3xx becomes `HTTP 3xx` (review R-4, D-19).
        redirect: "manual",
      });
      const text = await readBody(response, typeof message.id === "number" ? message.id : undefined);
      return { status: response.status, text, sessionId: response.headers?.get("mcp-session-id") ?? undefined };
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new McpError("request_failed", timeout.aborted ? `no answer within ${limitMs / 1000}s` : "network error");
    }
  }

  function statusError(answer: Answer): McpError {
    const { status } = answer;
    if (status === 401) return new McpError("credential_expired", REJECTED_KEY_MESSAGE, status);
    if (status === 403) return new McpError("forbidden", clip(answer.text) || "HTTP 403", status);
    if (status === 429) return new McpError("rate_limited", "New Relic rate limit reached; retry later", status);
    return new McpError("request_failed", `HTTP ${status}`, status);
  }

  /** The JSON-RPC answer to `id`, from a plain JSON body or Streamable HTTP SSE events. */
  function rpcAnswer(answer: Answer, id: number): Record<string, unknown> {
    if (answer.status !== 200) throw statusError(answer);
    const message = parseRpc(answer.text, id);
    if (!message) throw new McpError("request_failed", "unexpected response");
    if (message.error) throw new McpError("rpc", clip(String(message.error.message ?? "unknown error")));
    return message.result ?? {};
  }

  async function initialize(): Promise<string | undefined> {
    const never = new AbortController().signal; // shared by concurrent callers; bounded by its own timeout
    const id = nextId++;
    const params = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "compozy-newrelic", version: "0.2" } };
    const answer = await post({ id, method: "initialize", params }, undefined, timeoutMs, never);
    if (answer.status === 403 || answer.status === 404) throw new McpError("unavailable", `HTTP ${answer.status}`, answer.status);
    const tools = (rpcAnswer(answer, id).capabilities as { tools?: unknown } | undefined)?.tools;
    if (!tools || typeof tools !== "object") throw new McpError("request_failed", "no tools capability in initialize result");
    const ack = await post({ method: "notifications/initialized" }, answer.sessionId, timeoutMs, never);
    if (ack.status >= 300) throw statusError(ack);
    return answer.sessionId;
  }

  /** One request on the current session; an expired session is re-initialized once (BR-10). */
  async function request(method: string, params: Record<string, unknown>, limitMs: number, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      const current = (session ??= initialize());
      let sessionId: string | undefined;
      try {
        sessionId = await current;
      } catch (error) {
        if (session === current) session = undefined;
        throw error;
      }
      const id = nextId++;
      const answer = await post({ id, method, params }, sessionId, limitMs, signal);
      const expired = !!sessionId && (answer.status === 404 || (answer.status === 400 && /session/i.test(answer.text)));
      if (!expired) return rpcAnswer(answer, id);
      if (session === current) session = undefined;
      if (attempt > 0) throw new McpError("request_failed", "session expired twice", answer.status);
    }
  }

  return {
    async listTools(signal) {
      const tools: McpToolDef[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await request("tools/list", cursor ? { cursor } : {}, timeoutMs, signal);
        if (!Array.isArray(result.tools)) throw new McpError("request_failed", "unexpected response");
        tools.push(...result.tools.filter(isToolDef));
        if (typeof result.nextCursor !== "string" || !result.nextCursor) return tools;
        cursor = result.nextCursor;
      }
      throw new McpError("request_failed", "too many tools/list pages");
    },
    async callTool(name, args, signal) {
      const result = await request("tools/call", { name, arguments: args }, callTimeoutMs, signal);
      return {
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        isError: result.isError === true,
      };
    },
  };
}

/**
 * The body text; an SSE stream is read incrementally and cancelled at the first complete event that
 * carries the answer to `id`, so a server that keeps the stream open still answers (review R-6).
 */
async function readBody(response: Response, id: number | undefined): Promise<string> {
  const sse = /text\/event-stream/i.test(response.headers?.get("content-type") ?? "");
  if (!sse || id === undefined || !response.body) return await response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      const end = buffer.lastIndexOf("\n\n");
      const complete = done ? buffer : buffer.slice(0, Math.max(end, 0));
      if (done || (complete && parseRpc(complete, id))) return complete;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function isToolDef(value: unknown): value is McpToolDef {
  return !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
}

/** Plain JSON, or SSE events whose `data:` lines carry JSON-RPC messages; picks the answer to `id`. */
export function parseRpc(text: string, id: number): RpcMessage | null {
  const events = text.split(/\r?\n\r?\n/).map(event =>
    event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n")
  );
  for (const candidate of [text, ...events]) {
    try {
      const parsed = JSON.parse(candidate) as RpcMessage;
      if (parsed && typeof parsed === "object" && parsed.id === id && ("result" in parsed || "error" in parsed)) return parsed;
    } catch {
      // not JSON; try the next candidate
    }
  }
  return null;
}
