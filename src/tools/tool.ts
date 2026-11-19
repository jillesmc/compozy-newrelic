import type { ExtensionToolOptions, JSONValue, ToolResult } from "@compozy/extension-sdk";

import { paramsError } from "../errors.ts";
import { redactDeep, redactor } from "../items.ts";
import type { McpCatalog } from "../mcp-catalog.ts";
import { createNerdGraphClient, regionEndpoints, resolveApiKey, type NerdGraphClient, type RegionEndpoints } from "../nerdgraph.ts";
import { parseRegion, REGION_PATTERN } from "../params.ts";
import { withBudget } from "../poll.ts";
import { PROJECT_FILE, resolveProjectValues } from "../project-config.ts";

/** Per-call budget for a tool (same as a source poll). */
export const TOOL_BUDGET_MS = 25_000;

export interface ToolDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  mcpTimeoutMs?: number;
  /** Per-call budget; defaults to TOOL_BUDGET_MS. */
  budgetMs?: number;
  /** Clock for `since` filters and the MCP catalog TTL; defaults to the wall clock. */
  now?: () => Date;
  stderr?: { write(line: string): unknown };
  /** The process MCP catalog shared by the proxy tools (index.ts builds it). */
  mcp?: McpCatalog;
}

export interface ToolContext {
  /** NerdGraph client whose answers are already redacted of the bound key. */
  client: NerdGraphClient;
  endpoints: RegionEndpoints;
  signal: AbortSignal;
  now: () => Date;
}

/** A registered tool: the SDK registration fields plus a handler over the raw input. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONValue;
  command?: ExtensionToolOptions["command"];
  /** `root` is the call's `trustedWorkspace.root`; absent when the call has no trusted workspace. */
  handle(input: Record<string, unknown>, deps: ToolDeps, root?: string): Promise<ToolResult | string>;
}

/** A NerdGraph-backed investigation tool; `run` gets a ready client (key checked before any I/O). */
export interface NerdGraphTool {
  name: string;
  description: string;
  inputSchema: JSONValue;
  /** `account_id` (and `app` for `{{app}}` in `where`) default from the project file, then the env. */
  project?: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const REGION_PROPERTY = { type: "string", pattern: REGION_PATTERN, default: "us" } as const;
export const ACCOUNT_PROPERTIES = {
  account_id: {
    type: "integer",
    minimum: 1,
    description: `Defaults to account_id in ${PROJECT_FILE} of the trusted workspace, then NEW_RELIC_ACCOUNT_ID`,
  },
  region: REGION_PROPERTY,
} as const;
export const APP_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: `Fills {{app}} in where; defaults to app in ${PROJECT_FILE} of the trusted workspace`,
} as const;

export function accountId(input: Record<string, unknown>): number {
  const id = input.account_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw paramsError(`set account_id (a positive integer), account_id in ${PROJECT_FILE}, or NEW_RELIC_ACCOUNT_ID`);
  }
  return id;
}

/** Wraps a NerdGraph tool: region, key (no network when absent), redacting client, 25 s budget. */
export function nerdgraphTool(tool: NerdGraphTool): ToolDefinition {
  return {
    name: tool.name,
    description: `${tool.description} Read-only; works with a New Relic User API key on any plan.`,
    inputSchema: tool.inputSchema,
    async handle(given, deps, root) {
      const input = tool.project ? (resolveProjectValues(given, deps.env ?? {}, root, "") as Record<string, unknown>) : given;
      const region = parseRegion(input.region);
      const apiKey = resolveApiKey(deps.env ?? {});
      const redact = redactor(apiKey);
      const raw = createNerdGraphClient(region, apiKey, { fetch: deps.fetch, requestTimeoutMs: deps.requestTimeoutMs });
      const client: NerdGraphClient = {
        query: async (gql, variables, signal) => redactDeep(await raw.query(gql, variables, signal), redact),
        nrql: async (id, nrql, signal) => redactDeep(await raw.nrql(id, nrql, signal), redact),
      };
      // Same budget handling as a poll, so a slow call reports "tool budget exceeded" (review R-5).
      return await withBudget(
        deps.budgetMs ?? TOOL_BUDGET_MS,
        signal => tool.run(input, { client, endpoints: regionEndpoints(region), signal, now: deps.now ?? (() => new Date()) }),
        "tool"
      );
    },
  };
}
