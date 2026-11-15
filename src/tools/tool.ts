import type { ExtensionToolOptions, JSONValue, ToolResult } from "@compozy/extension-sdk";

import { paramsError } from "../errors.ts";
import { redactDeep, redactor } from "../items.ts";
import { createNerdGraphClient, regionEndpoints, resolveApiKey, type NerdGraphClient, type RegionEndpoints } from "../nerdgraph.ts";
import { parseRegion, REGION_PATTERN } from "../params.ts";
import { withBudget } from "../poll.ts";

/** Per-call budget for a tool (same as a source poll). */
export const TOOL_BUDGET_MS = 25_000;

export interface ToolDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  mcpTimeoutMs?: number;
  /** Per-call budget; defaults to TOOL_BUDGET_MS. */
  budgetMs?: number;
  /** Clock for `since` filters; defaults to the wall clock. */
  now?: () => Date;
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
  handle(input: Record<string, unknown>, deps: ToolDeps): Promise<ToolResult | string>;
}

/** A NerdGraph-backed investigation tool; `run` gets a ready client (key checked before any I/O). */
export interface NerdGraphTool {
  name: string;
  description: string;
  inputSchema: JSONValue;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const REGION_PROPERTY = { type: "string", pattern: REGION_PATTERN, default: "us" } as const;
export const ACCOUNT_PROPERTIES = {
  account_id: { type: "integer", minimum: 1 },
  region: REGION_PROPERTY,
} as const;

export function accountId(input: Record<string, unknown>): number {
  const id = input.account_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw paramsError("account_id must be your New Relic account id (a positive integer)");
  }
  return id;
}

/** Wraps a NerdGraph tool: region, key (no network when absent), redacting client, 25 s budget. */
export function nerdgraphTool(tool: NerdGraphTool): ToolDefinition {
  return {
    name: tool.name,
    description: `${tool.description} Read-only; works with a New Relic User API key on any plan.`,
    inputSchema: tool.inputSchema,
    async handle(input, deps) {
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
