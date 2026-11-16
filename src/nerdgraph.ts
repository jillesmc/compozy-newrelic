import { sourceError, SourceError } from "./errors.ts";
import { redactor } from "./items.ts";
import { networkFailureReason } from "./system-ca.ts";

/** `loopback:<port>` is the always-compiled, undocumented local testing aid (Deviations D-1, D-3). */
export type Region = "us" | "eu" | `loopback:${number}`;

export interface NerdGraphClient {
  query<T>(gql: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T>;
  nrql(accountId: number, nrql: string, signal: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface RegionEndpoints {
  graphql: string;
  mcp: string;
  /** New Relic UI base for item links; absent for loopback. */
  web?: string;
  /** New Relic's issue redirect host (the official issuePageUrl); absent for loopback. */
  issues?: string;
}

/** Links one alert issue through New Relic's own redirect to its UI page (D-21); undefined for loopback. */
export function issueUrl(endpoints: RegionEndpoints, accountId: number, issueId: string): string | undefined {
  if (!endpoints.issues || !issueId) return undefined;
  return `${endpoints.issues}/accounts/${accountId}/issues/${encodeURIComponent(issueId)}`;
}

export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 300;
export const NRQL_QUERY =
  "query($id:Int!,$q:Nrql!){actor{account(id:$id){nrql(query:$q,timeout:20){results}}}}";

export const MISSING_KEY_MESSAGE =
  "New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY";
export const REJECTED_KEY_MESSAGE = "New Relic rejected the API key; bind a User API key (NRAK-...)";

/** Resolves NerdGraph, MCP and UI endpoints for a region (UT-081). */
export function regionEndpoints(region: Region): RegionEndpoints {
  if (region === "us") {
    return {
      graphql: "https://api.newrelic.com/graphql",
      mcp: "https://mcp.newrelic.com/mcp/",
      web: "https://one.newrelic.com",
      issues: "https://radar-api.service.newrelic.com",
    };
  }
  if (region === "eu") {
    return {
      graphql: "https://api.eu.newrelic.com/graphql",
      mcp: "https://mcp.eu.newrelic.com/mcp/",
      web: "https://one.eu.newrelic.com",
      issues: "https://radar-api.service.eu.newrelic.com",
    };
  }
  const port = Number(region.slice("loopback:".length));
  return { graphql: `http://127.0.0.1:${port}/graphql`, mcp: `http://127.0.0.1:${port}/mcp/` };
}

/**
 * Reads NEW_RELIC_API_KEY from an explicitly passed environment and checks its form without any
 * network call (UT-080): absent → source_credential_absent; not a User key → source_credential_expired.
 */
export function resolveApiKey(env: Record<string, string | undefined>): string {
  const apiKey = env.NEW_RELIC_API_KEY?.trim() ?? "";
  if (!apiKey) throw sourceError("source_credential_absent", MISSING_KEY_MESSAGE);
  if (!apiKey.startsWith("NRAK-")) throw sourceError("source_credential_expired", REJECTED_KEY_MESSAGE);
  return apiKey;
}

interface GraphQLError {
  message?: unknown;
  extensions?: { errorClass?: unknown };
}

export function createNerdGraphClient(
  region: Region,
  apiKey: string,
  options: { fetch?: typeof fetch; requestTimeoutMs?: number } = {}
): NerdGraphClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = regionEndpoints(region).graphql;
  const redact = redactor(apiKey);

  async function query<T>(gql: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "API-Key": apiKey, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ query: gql, variables }),
        signal: AbortSignal.any([signal, timeout]),
        redirect: "manual", // never resend the key to a redirect target (D-19); a 3xx fails as non-ok
      });
      text = await response.text();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const reason = timeout.aborted ? `no answer within ${timeoutMs / 1000}s` : networkFailureReason(error);
      throw sourceError("source_extension_failed", `New Relic request failed: ${reason}`);
    }
    const status = response.status;
    if (status === 401 || status === 403) throw sourceError("source_credential_expired", REJECTED_KEY_MESSAGE, status);
    if (status === 429) throw sourceError("source_rate_limited", "New Relic rate limit reached; retry later", status);
    if (!response.ok) throw sourceError("source_extension_failed", `New Relic request failed: ${status}`, status);
    const body = parseJson(text) as { data?: unknown; errors?: unknown } | null;
    if (!body || typeof body !== "object") {
      throw sourceError("source_extension_failed", "New Relic request failed: unexpected response", status);
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw graphqlError(body.errors as GraphQLError[], variables.id, redact);
    }
    return body.data as T;
  }

  return {
    query,
    async nrql(accountId, nrql, signal) {
      type Data = { actor?: { account?: { nrql?: { results?: unknown } } | null } };
      const data = await query<Data>(NRQL_QUERY, { id: accountId, q: nrql }, signal);
      const account = data?.actor?.account;
      if (!account) throw accountError(accountId);
      const results = account.nrql?.results;
      if (!Array.isArray(results)) {
        throw sourceError("source_extension_failed", "New Relic request failed: unexpected response");
      }
      return results.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    },
  };
}

export function accountError(accountId: unknown): SourceError {
  return sourceError("source_params_invalid", `this API key cannot read account ${String(accountId)}`);
}

/**
 * Maps GraphQL `errors[]` on HTTP 200; external text is redacted before the 300-character bound.
 * `extensions.errorClass` decides when present; the message heuristics apply only without a class, so
 * a syntax error that merely mentions "timeout" or "account" keeps its own text (review R-8).
 */
function graphqlError(errors: GraphQLError[], accountId: unknown, redact: (text: string) => string): SourceError {
  const messages = errors.map(error => (typeof error.message === "string" ? error.message : ""));
  const classes = errors.map(error => String(error.extensions?.errorClass ?? "").toUpperCase()).filter(Boolean);
  const all = messages.join("; ");
  const classified = classes.length > 0;
  const is = (errorClass: string, heuristic: () => boolean) => (classified ? classes.includes(errorClass) : heuristic());
  if (is("UNAUTHORIZED", () => /invalid (user )?api key/i.test(all))) {
    return sourceError("source_credential_expired", REJECTED_KEY_MESSAGE);
  }
  if (is("TIMEOUT", () => /timed? ?out/i.test(all))) {
    return sourceError("source_extension_failed", "New Relic request failed: query timed out");
  }
  const accessDenied = is("FORBIDDEN", () => /account/i.test(all) && /access|authori[sz]|permission|forbidden/i.test(all));
  if (accessDenied && typeof accountId === "number") return accountError(accountId);
  const text = (redact(all) || "unknown error").slice(0, MAX_ERROR_CHARS);
  return sourceError("source_params_invalid", `New Relic rejected the query: ${text}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
