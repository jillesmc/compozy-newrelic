import { McpError, type McpClient, type McpToolDef } from "./mcp-client.ts";
import type { Region } from "./nerdgraph.ts";

/**
 * Per-region catalog of the official New Relic MCP (Business Rules 1–4): a 10-minute TTL cache of
 * `tools/list`, the annotation-only exposure filter, the OAuth-only set and the region state.
 */
export const CATALOG_TTL_MS = 10 * 60_000;
/** `unknown` regions (and failed refreshes of a stale catalog) are retried at most once per minute. */
export const RETRY_MS = 60_000;
export const OAUTH_ONLY_SEED = ["natural_language_to_nrql_query", "search_traces"] as const;
export const UNAVAILABLE_HINT = "use the ext__newrelic__* NerdGraph tools";

/** Process-lifetime OAuth-only set (Business Rule 2): the seed plus learned tools. */
const PROCESS_OAUTH_ONLY = new Set<string>(OAUTH_ONLY_SEED);

export type RegionState = "available" | "unavailable" | "unknown";
export type HiddenReason = "oauth_only" | "not_read_only" | "unknown_tool";
export type Exposure = { exposed: true } | { exposed: false; reason: HiddenReason };
export interface HiddenCounts {
  oauth_only: number;
  not_read_only: number;
}

export interface McpCatalog {
  state(region: Region): RegionState;
  /** Exposed tools only, sorted by name; `query` is a case-insensitive substring of name or description. */
  tools(region: Region, query?: string): Promise<McpToolDef[]>;
  /** Hidden counts of the last loaded catalog of `region`. */
  hidden(region: Region): HiddenCounts;
  exposure(region: Region, name: string): Promise<Exposure>;
  learnOAuthOnly(name: string): void;
  /** The region's session-reusing client (the proxy forwards calls through it). */
  client(region: Region): McpClient;
}

export interface McpCatalogOptions {
  client: (region: Region) => McpClient;
  now?: () => number;
  stderr?: { write(line: string): unknown };
  oauthOnly?: Set<string>;
}

/** Business Rule 1: annotations only; a missing annotation means not read-only. */
export function isReadOnly(tool: McpToolDef): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
}

export function classify(tool: McpToolDef, oauthOnly: ReadonlySet<string>): Exposure {
  if (oauthOnly.has(tool.name)) return { exposed: false, reason: "oauth_only" };
  if (!isReadOnly(tool)) return { exposed: false, reason: "not_read_only" };
  return { exposed: true };
}

export function hiddenCounts(tools: McpToolDef[], oauthOnly: ReadonlySet<string> = PROCESS_OAUTH_ONLY): HiddenCounts {
  const counts = { oauth_only: 0, not_read_only: 0 };
  for (const tool of tools) {
    const exposure = classify(tool, oauthOnly);
    if (!exposure.exposed && exposure.reason !== "unknown_tool") counts[exposure.reason]++;
  }
  return counts;
}

/** The process OAuth-only set (read by the doctor). */
export function processOAuthOnly(): ReadonlySet<string> {
  return PROCESS_OAUTH_ONLY;
}

interface Entry {
  client: McpClient;
  state: RegionState;
  /** HTTP status or error text behind a non-available state. */
  reason: string;
  tools: McpToolDef[];
  fetchedAt: number;
  checkedAt: number | undefined;
  refreshing: Promise<McpError | undefined> | undefined;
}

export function createMcpCatalog(options: McpCatalogOptions): McpCatalog {
  const now = options.now ?? Date.now;
  const stderr = options.stderr ?? process.stderr;
  const oauthOnly = options.oauthOnly ?? PROCESS_OAUTH_ONLY;
  const entries = new Map<Region, Entry>();

  const entry = (region: Region): Entry => {
    let found = entries.get(region);
    if (!found) {
      found = { client: options.client(region), state: "unknown", reason: "not probed", tools: [], fetchedAt: 0, checkedAt: undefined, refreshing: undefined };
      entries.set(region, found);
    }
    return found;
  };

  function setState(region: Region, current: Entry, state: RegionState, reason: string, status?: number): void {
    const changed = current.state !== state;
    current.state = state;
    current.reason = reason;
    if (!changed) return;
    const label = state === "unavailable" ? `unavailable(${status ?? "error"})` : state;
    stderr.write(`newrelic: region=${region} mcp=${label}\n`);
  }

  /** Lists the tools; returns the error a caller should see when the region is left non-available. */
  async function refresh(region: Region, current: Entry): Promise<McpError | undefined> {
    const started = now();
    current.checkedAt = started;
    try {
      current.tools = await current.client.listTools(new AbortController().signal);
      current.fetchedAt = started;
      setState(region, current, "available", "");
      return undefined;
    } catch (error) {
      const failure = error instanceof McpError ? error : new McpError("request_failed", "unexpected error");
      // Business Rule 3: a failed refresh keeps the previous catalog for at most one more TTL.
      if (current.state === "available" && started - current.fetchedAt < 2 * CATALOG_TTL_MS) return undefined;
      const noMcp = failure.kind === "unavailable" || failure.kind === "forbidden";
      const reason = failure.status !== undefined ? String(failure.status) : failure.message;
      current.tools = [];
      if (noMcp || current.state === "available") setState(region, current, "unavailable", reason, failure.status);
      else setState(region, current, "unknown", reason);
      return noMcp ? undefined : failure;
    }
  }

  /** Refreshes when due (TTL, retry cadence) and throws `unavailable` unless the region is available. */
  async function ensure(region: Region): Promise<Entry> {
    const current = entry(region);
    const at = now();
    const since = (time: number) => at - time;
    const due =
      current.checkedAt === undefined ||
      (current.state === "available"
        ? since(current.fetchedAt) >= CATALOG_TTL_MS && since(current.checkedAt) >= RETRY_MS
        : since(current.checkedAt) >= (current.state === "unavailable" ? CATALOG_TTL_MS : RETRY_MS));
    let failure: McpError | undefined;
    if (current.refreshing || due) {
      current.refreshing ??= refresh(region, current).finally(() => (current.refreshing = undefined));
      failure = await current.refreshing;
    }
    if (current.state === "available") return current;
    throw failure ?? new McpError("unavailable", `New Relic MCP unavailable for this API key (${current.reason}); ${UNAVAILABLE_HINT}`);
  }

  return {
    state: region => entries.get(region)?.state ?? "unknown",
    async tools(region, query) {
      const current = await ensure(region);
      const needle = query?.toLowerCase() ?? "";
      return current.tools
        .filter(tool => classify(tool, oauthOnly).exposed)
        .filter(tool => !needle || `${tool.name}\n${tool.description ?? ""}`.toLowerCase().includes(needle))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    hidden: region => hiddenCounts(entries.get(region)?.tools ?? [], oauthOnly),
    async exposure(region, name) {
      // Seeded or learned OAuth-only tools are refused before any network request (UT-150).
      if (oauthOnly.has(name)) return { exposed: false, reason: "oauth_only" };
      const tool = (await ensure(region)).tools.find(candidate => candidate.name === name);
      return tool ? classify(tool, oauthOnly) : { exposed: false, reason: "unknown_tool" };
    },
    learnOAuthOnly(name) {
      if (oauthOnly.has(name)) return;
      oauthOnly.add(name);
      stderr.write(`newrelic: mcp tool ${name.replace(/[^\w.-]/g, "?").slice(0, 100)} requires OAuth; hidden\n`);
    },
    client: region => entry(region).client,
  };
}
