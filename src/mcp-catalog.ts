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
  /**
   * Records an availability failure seen outside a refresh (an initialize 403/404 on a session
   * re-handshake): the region becomes unavailable, re-probed after one TTL. Returns the error to show.
   */
  markUnavailable(region: Region, failure: McpError): McpError;
  /**
   * Doctor and startup probe (Core Feature 4): lists the tools now and feeds the shared region state,
   * without a state-change stderr line (the probe prints its own). Returns this attempt's failure.
   */
  probe(region: Region): Promise<McpError | undefined>;
}

export interface McpCatalogOptions {
  client: (region: Region) => McpClient;
  now?: () => number;
  stderr?: { write(line: string): unknown };
  oauthOnly?: Set<string>;
  /** Redacts the bound key from remote text before it is logged (Business Rule 7). */
  redact?: (text: string) => string;
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
  /** Failure of the last attempt; undefined after a success. */
  lastFailure: McpError | undefined;
  refreshing: Promise<McpError | undefined> | undefined;
}

export function createMcpCatalog(options: McpCatalogOptions): McpCatalog {
  const now = options.now ?? Date.now;
  const stderr = options.stderr ?? process.stderr;
  const oauthOnly = options.oauthOnly ?? PROCESS_OAUTH_ONLY;
  const redact = options.redact ?? ((text: string) => text);
  const entries = new Map<Region, Entry>();

  const entry = (region: Region): Entry => {
    let found = entries.get(region);
    if (!found) {
      found = { client: options.client(region), state: "unknown", reason: "not probed", tools: [], fetchedAt: 0, checkedAt: undefined, lastFailure: undefined, refreshing: undefined };
      entries.set(region, found);
    }
    return found;
  };

  function setState(region: Region, current: Entry, state: RegionState, reason: string, status?: number, quiet = false): void {
    const changed = current.state !== state;
    current.state = state;
    current.reason = reason;
    if (state !== "available") current.tools = [];
    if (!changed || quiet) return;
    const label = state === "unavailable" ? `unavailable(${status ?? "error"})` : state;
    stderr.write(`newrelic: region=${region} mcp=${label}\n`);
  }

  const reasonOf = (failure: McpError) => (failure.status !== undefined ? String(failure.status) : failure.message);
  const unavailableError = (current: Entry) =>
    new McpError("unavailable", `New Relic MCP unavailable for this API key (${current.reason}); ${UNAVAILABLE_HINT}`);
  const expired = (current: Entry, at: number) => at - current.fetchedAt >= 2 * CATALOG_TTL_MS;

  /**
   * Lists the tools; returns the error a caller should see when the region is left non-available.
   * `forced` (doctor, startup probe) is authoritative: no stale-catalog grace (review R-5).
   */
  async function refresh(region: Region, current: Entry, forced = false): Promise<McpError | undefined> {
    const quiet = forced;
    const started = now();
    current.checkedAt = started;
    try {
      const tools = await current.client.listTools(new AbortController().signal);
      current.tools = tools;
      current.fetchedAt = started;
      current.lastFailure = undefined;
      setState(region, current, "available", "", undefined, quiet);
      return undefined;
    } catch (error) {
      const failure = error instanceof McpError ? error : new McpError("request_failed", "unexpected error");
      current.lastFailure = failure;
      const noMcp = failure.kind === "unavailable" || failure.kind === "forbidden";
      const transient = !noMcp && failure.kind !== "credential_expired";
      const wasAvailable = current.state === "available";
      // Business Rule 3: only the proxy's own refresh, after a transient failure, keeps the previous
      // catalog, for at most one more TTL, measured with the clock now, after the request (review R-2).
      if (wasAvailable && transient && !forced && !expired(current, now())) return undefined;
      if (noMcp || (wasAvailable && !(forced && transient))) {
        setState(region, current, "unavailable", reasonOf(failure), failure.status, quiet);
      } else setState(region, current, "unknown", reasonOf(failure), undefined, quiet);
      // A refusal or an expired grace answers the standard mcp_unavailable text; others keep their error.
      return noMcp || (wasAvailable && transient && !forced) ? undefined : failure;
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
    // Business Rule 3 hard limit, independent of the retry throttle (review R-2): when the retry is not
    // due yet, a stale catalog whose refresh already failed is not used two TTLs after the last success.
    if (!due && !current.refreshing && current.state === "available" && current.lastFailure && expired(current, at)) {
      setState(region, current, "unavailable", reasonOf(current.lastFailure), current.lastFailure.status);
    }
    if (current.refreshing || due) {
      current.refreshing ??= refresh(region, current).finally(() => (current.refreshing = undefined));
      failure = await current.refreshing;
    }
    // Re-read the clock after any await: a refresh (ours or one we joined) may cross the limit (R-2).
    const failed = current.lastFailure;
    if (current.state === "available" && failed && expired(current, now())) {
      setState(region, current, "unavailable", reasonOf(failed), failed.status);
    }
    if (current.state === "available") return current;
    throw failure ?? unavailableError(current);
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
      // Redact before sanitizing or shortening (review R-1).
      stderr.write(`newrelic: mcp tool ${redact(name).replace(/[^\w.-]/g, "?").slice(0, 100)} requires OAuth; hidden\n`);
    },
    client: region => entry(region).client,
    markUnavailable(region, failure) {
      const current = entry(region);
      current.checkedAt = now(); // re-probed after one TTL, like a failed probe
      current.lastFailure = failure;
      setState(region, current, "unavailable", reasonOf(failure), failure.status);
      return unavailableError(current);
    },
    async probe(region) {
      const current = entry(region);
      current.refreshing ??= refresh(region, current, true).finally(() => (current.refreshing = undefined));
      await current.refreshing;
      return current.lastFailure;
    },
  };
}
