import { RPCError, type JSONValue, type ToolResult } from "@compozy/extension-sdk";

import { paramsError } from "../errors.ts";
import { byteLength, redactDeep, redactor, truncateBytes, truncateChars } from "../items.ts";
import { createMcpCatalog, type HiddenReason, type McpCatalog } from "../mcp-catalog.ts";
import { createMcpClient, McpError, type McpToolDef } from "../mcp-client.ts";
import { resolveApiKey, type Region } from "../nerdgraph.ts";
import { parseRegion } from "../params.ts";
import { REGION_PROPERTY, type ToolDefinition, type ToolDeps } from "./tool.ts";

/** Business Rule 6 and 8 bounds. */
export const MAX_MCP_TEXT_BYTES = 16 * 1024;
export const MAX_ARGUMENT_BYTES = 64 * 1024;
export const MAX_CATALOG_ROWS = 60;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_PROPERTY_CHARS = 80;
const MAX_TOOL_NAME_CHARS = 200;

/** The catalog shared by both proxy tools; index.ts builds one per process. */
export function createProxyCatalog(deps: ToolDeps): McpCatalog {
  const apiKey = () => resolveApiKey(deps.env ?? {}); // resolved on first use; callers check it first
  return createMcpCatalog({
    client: region => createMcpClient(region, apiKey(), { fetch: deps.fetch }),
    now: () => (deps.now?.() ?? new Date()).getTime(),
    stderr: deps.stderr,
    redact: text => redactor(apiKey())(text),
  });
}

function mcpToolError(code: string, message: string, extra: Record<string, JSONValue> = {}): RPCError {
  return new RPCError(-32000, message, { code, ...extra });
}

/** Maps a client or catalog failure to the Integration Points tool errors. */
function failure(error: unknown): unknown {
  if (!(error instanceof McpError)) return error;
  switch (error.kind) {
    case "unavailable":
      return mcpToolError("mcp_unavailable", error.message);
    case "credential_expired":
      return mcpToolError("credential_expired", error.message);
    case "rate_limited":
      return mcpToolError("rate_limited", error.message);
    default:
      return mcpToolError("mcp_request_failed", error.message);
  }
}

function refusal(tool: string, reason: HiddenReason, region: Region): RPCError {
  const server = region === "eu" ? "newrelic-eu" : "newrelic";
  const message =
    reason === "oauth_only"
      ? `${tool} requires OAuth; sign in with compozy mcp auth login ${server} or use another tool`
      : reason === "not_read_only"
        ? `${tool} is not marked read-only by New Relic; the proxy does not call it`
        : `${tool} is not in the New Relic MCP catalog for region ${region}`;
  // Recovery for oauth_only names the region's OAuth server; the others use the default (format.ts).
  const recovery = `sign in with compozy mcp auth login ${server} or use another ext__newrelic__mcp_tools tool`;
  return mcpToolError("mcp_tool_not_exposed", message, { reason, ...(reason === "oauth_only" ? { recovery } : {}) });
}

/** Resolves the key (no network when absent) and the shared catalog. */
function setup(input: Record<string, unknown>, deps: ToolDeps) {
  const region = parseRegion(input.region);
  const apiKey = resolveApiKey(deps.env ?? {});
  return { region, redact: redactor(apiKey), catalog: deps.mcp ?? createProxyCatalog(deps) };
}

function result(value: Record<string, JSONValue>, text: string, truncated: boolean): ToolResult {
  return { content: [{ type: "text", text }], structured: value, truncated, bytes: byteLength(text), duration_ms: 0 };
}

const identity = (text: string) => text;

/**
 * `prop: "type — description"` per input property (description ≤ 80 characters). Remote text is
 * redacted before it is normalized or shortened (review R-3).
 */
export function compactSchema(schema: unknown, redact: (text: string) => string = identity): Record<string, string> {
  const properties = (schema as { properties?: unknown } | undefined)?.properties;
  if (!properties || typeof properties !== "object") return {};
  return Object.fromEntries(
    Object.entries(properties as Record<string, { type?: unknown; description?: unknown }>).map(([name, property]) => {
      const raw = property?.type;
      const type = redact(typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("|") : "any");
      const description = typeof property?.description === "string" ? oneLine(redact(property.description)) : "";
      return [redact(name), description ? `${type} — ${truncateChars(description, MAX_PROPERTY_CHARS)}` : type];
    })
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function row(tool: McpToolDef, redact: (text: string) => string): Record<string, JSONValue> {
  return {
    name: redact(tool.name),
    description: truncateChars(oneLine(redact(tool.description ?? "")), MAX_DESCRIPTION_CHARS),
    input: compactSchema(tool.inputSchema, redact),
  };
}

export const mcpToolsTool: ToolDefinition = {
  name: "mcp_tools",
  description:
    "List the official New Relic MCP tools usable with the bound API key (read-only, not OAuth-only): name, " +
    "short description and compact input. Narrow with `query`; then call one with ext__newrelic__mcp_call.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      region: REGION_PROPERTY,
      query: { type: "string", maxLength: 200, description: "Case-insensitive substring of the tool name or description" },
      limit: { type: "integer", minimum: 1, maximum: MAX_CATALOG_ROWS, default: MAX_CATALOG_ROWS },
    },
  },
  async handle(input, deps) {
    const { region, redact, catalog } = setup(input, deps);
    if (input.query !== undefined && typeof input.query !== "string") throw paramsError("query must be a string");
    const limit = input.limit ?? MAX_CATALOG_ROWS;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_ROWS) {
      throw paramsError(`limit must be an integer from 1 to ${MAX_CATALOG_ROWS}`);
    }
    try {
      const tools = await catalog.tools(region, input.query as string | undefined);
      const output = redactDeep(
        {
          region,
          state: catalog.state(region),
          exposed: tools.slice(0, limit).map(tool => row(tool, redact)),
          hidden: { ...catalog.hidden(region) },
          truncated: tools.length > limit,
        },
        redact
      );
      return result(output, JSON.stringify(output), output.truncated);
    } catch (error) {
      throw failure(error);
    }
  },
};

/** One-line stand-in for a non-text content part (Business Rule 6). */
function placeholder(part: Record<string, unknown>, redact: (text: string) => string): string {
  const resource = part.resource as { uri?: unknown } | undefined;
  const detail = [part.mimeType, part.uri, resource?.uri].find(value => typeof value === "string");
  return truncateChars(redact(`[${String(part.type ?? "unknown")} content omitted${detail ? `: ${String(detail)}` : ""}]`), 200);
}

export const mcpCallTool: ToolDefinition = {
  name: "mcp_call",
  description:
    "Call one official New Relic MCP tool listed by ext__newrelic__mcp_tools, passing `arguments` per its input. " +
    "Read-only; the result text is capped at 16 KiB.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool"],
    properties: {
      tool: { type: "string", minLength: 1, maxLength: MAX_TOOL_NAME_CHARS },
      arguments: { type: "object", description: "Arguments of the remote tool (at most 64 KiB as JSON)" },
      region: REGION_PROPERTY,
    },
  },
  async handle(input, deps) {
    const { region, redact, catalog } = setup(input, deps);
    const tool = input.tool;
    if (typeof tool !== "string" || !tool.trim() || tool.length > MAX_TOOL_NAME_CHARS) {
      throw paramsError("set tool to a name listed by ext__newrelic__mcp_tools");
    }
    const args = input.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw paramsError("arguments must be an object");
    if (byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) throw paramsError("arguments exceed 64 KiB; send a smaller request");
    const name = redact(tool);
    let exposure;
    try {
      exposure = await catalog.exposure(region, tool);
    } catch (error) {
      throw failure(error);
    }
    if (!exposure.exposed) throw refusal(name, exposure.reason, region);
    let remote;
    try {
      remote = await catalog.client(region).callTool(tool, args as Record<string, unknown>, new AbortController().signal);
    } catch (error) {
      // Business Rule 2 as narrowed by D-19.8: a 403 or JSON-RPC error saying `requires OAuth` teaches
      // the OAuth-only set; any other 403 is region-wide and never teaches a tool.
      const oauth = error instanceof McpError && (error.kind === "forbidden" || error.kind === "rpc") && /requires OAuth/i.test(error.message);
      if (oauth) {
        catalog.learnOAuthOnly(tool);
        throw refusal(name, "oauth_only", region);
      }
      // A plain 403 on tools/call, or an initialize 403/404 on a session re-handshake, makes the whole
      // region unavailable (review R-5).
      if (error instanceof McpError && (error.kind === "unavailable" || error.kind === "forbidden")) {
        throw failure(catalog.markUnavailable(region, error));
      }
      // A JSON-RPC error from the tool is relayed as a remote tool error (Integration Points).
      if (!(error instanceof McpError && error.kind === "rpc")) throw failure(error);
      remote = { content: [{ type: "text", text: error.message }], isError: true };
    }
    const joined = remote.content
      .map(part => {
        const entry = (part ?? {}) as Record<string, unknown>;
        return entry.type === "text" && typeof entry.text === "string" ? entry.text : placeholder(entry, redact);
      })
      .join("\n");
    if (remote.isError && /requires OAuth/i.test(joined)) {
      catalog.learnOAuthOnly(tool); // Deviation D-12
      throw refusal(name, "oauth_only", region);
    }
    const full = redact(joined);
    const text = truncateBytes(full, MAX_MCP_TEXT_BYTES);
    const structured = remote.structuredContent === undefined ? undefined : (redactDeep(remote.structuredContent, redact) as JSONValue);
    const structuredFits = structured !== undefined && byteLength(JSON.stringify(structured)) <= MAX_MCP_TEXT_BYTES;
    const truncated = text !== full || (structured !== undefined && !structuredFits);
    const output: Record<string, JSONValue> = {
      tool: name,
      is_error: remote.isError === true,
      text,
      ...(structuredFits ? { structured: structured! } : {}),
      truncated,
    };
    return result(output, text, truncated);
  },
};
