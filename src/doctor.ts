import { SourceError } from "./errors.ts";
import { classify, hiddenCounts, processOAuthOnly } from "./mcp-catalog.ts";
import { createMcpClient, McpError } from "./mcp-client.ts";
import { createNerdGraphClient, regionEndpoints, resolveApiKey, type Region } from "./nerdgraph.ts";

const ACCOUNTS_QUERY = "{ actor { accounts { id } } }";

export interface DoctorDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  mcpTimeoutMs?: number;
}

export type NerdGraphStatus = { ok: true; accounts: number } | { ok: false; code: string; message: string };
export type McpStatus =
  | { status: "available"; exposed: number; oauthOnly: number }
  | { status: "unavailable"; http: number }
  | { status: "unknown"; error: string };

export interface DoctorReport {
  region: Region;
  mcpUrl: string;
  nerdgraph: NerdGraphStatus;
  mcp: McpStatus;
}

/** Probes NerdGraph and the MCP endpoint; never throws and never calls an MCP tool (`initialize` only). */
export async function runDoctor(region: Region, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const mcpUrl = regionEndpoints(region).mcp;
  let apiKey: string;
  try {
    apiKey = resolveApiKey(deps.env ?? {});
  } catch (error) {
    return { region, mcpUrl, nerdgraph: failure(error), mcp: { status: "unknown", error: "no API key" } };
  }
  const [nerdgraph, mcp] = await Promise.all([probeNerdGraph(region, apiKey, deps), probeMcp(region, apiKey, deps)]);
  return { region, mcpUrl, nerdgraph, mcp };
}

async function probeNerdGraph(region: Region, apiKey: string, deps: DoctorDeps): Promise<NerdGraphStatus> {
  try {
    const client = createNerdGraphClient(region, apiKey, { fetch: deps.fetch, requestTimeoutMs: deps.requestTimeoutMs });
    type Data = { actor?: { accounts?: unknown } };
    const data = await client.query<Data>(ACCOUNTS_QUERY, {}, new AbortController().signal);
    const accounts = data?.actor?.accounts;
    return { ok: true, accounts: Array.isArray(accounts) ? accounts.length : 0 };
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown): NerdGraphStatus {
  if (error instanceof SourceError) {
    return { ok: false, code: String(error.data?.code ?? "").replace(/^source_/, ""), message: error.message };
  }
  return { ok: false, code: "extension_failed", message: "New Relic request failed: unexpected error" };
}

/**
 * Probes the MCP through the proxy client: `initialize` then `tools/list`; the counts use the same
 * exposure filter as `ext__newrelic__mcp_tools`. Never calls an MCP tool.
 */
export async function probeMcp(region: Region, apiKey: string, deps: DoctorDeps = {}): Promise<McpStatus> {
  const client = createMcpClient(region, apiKey, { fetch: deps.fetch, timeoutMs: deps.mcpTimeoutMs });
  try {
    const tools = await client.listTools(new AbortController().signal);
    const oauthOnly = processOAuthOnly();
    const exposed = tools.filter(tool => classify(tool, oauthOnly).exposed).length;
    return { status: "available", exposed, oauthOnly: hiddenCounts(tools, oauthOnly).oauth_only };
  } catch (error) {
    if (!(error instanceof McpError)) return { status: "unknown", error: "unexpected error" };
    if (error.kind === "unavailable" || error.kind === "forbidden" || error.kind === "credential_expired") {
      return { status: "unavailable", http: error.status ?? 0 };
    }
    return { status: "unknown", error: error.kind === "rate_limited" ? "HTTP 429" : error.message.slice(0, 200) };
  }
}

/** Operator report, exactly the `_dx.md` Golden Path lines. */
export function formatReport(report: DoctorReport): string {
  const ng = report.nerdgraph;
  const nerdgraph = ng.ok
    ? `NerdGraph: ok (region ${report.region}, ${plural(ng.accounts, "account")} visible)`
    : `NerdGraph: failed (${ng.message})`;
  const keepTools = "agents keep the ext__newrelic__* tools";
  const mcp =
    report.mcp.status === "available"
      ? `MCP: available (${plural(report.mcp.exposed, "tool")} exposed via API key; ${report.mcp.oauthOnly} OAuth-only hidden) — ` +
        "agents can use ext__newrelic__mcp_tools / mcp_call"
      : report.mcp.status === "unavailable"
        ? `MCP: unavailable (${report.mcp.http} from ${report.mcpUrl}) — ${keepTools}; skip the MCP login`
        : `MCP: unknown (${report.mcp.error}) — ${keepTools}; run the doctor again later`;
  return `${nerdgraph}\n${mcp}`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The one startup stderr line (Deviation D-S3-b): codes and statuses only, never free text. */
export function formatProbeLine(report: DoctorReport): string {
  const nerdgraph = report.nerdgraph.ok ? "ok" : report.nerdgraph.code;
  const mcp = report.mcp.status === "unavailable" ? `unavailable:${report.mcp.http}` : report.mcp.status;
  return `newrelic: probe region=${report.region} nerdgraph=${nerdgraph} mcp=${mcp}\n`;
}

/** Runs once at extension start; writes exactly one line and never throws (IT-013). */
export async function startupProbe(
  deps: DoctorDeps & { stderr?: { write(line: string): unknown }; region?: Region } = {}
): Promise<void> {
  const region = deps.region ?? "us";
  let line = `newrelic: probe region=${region} nerdgraph=unknown mcp=unknown\n`;
  try {
    line = formatProbeLine(await runDoctor(region, deps));
  } catch {
    // keep the fallback line; startup never fails because of the probe
  }
  (deps.stderr ?? process.stderr).write(line);
}
