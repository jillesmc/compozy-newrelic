import { SourceError } from "./errors.ts";
import { createNerdGraphClient, regionEndpoints, resolveApiKey, type Region } from "./nerdgraph.ts";

/** MCP `initialize` probe timeout (spec: Queries → Doctor). */
export const MCP_PROBE_TIMEOUT_MS = 5_000;
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const ACCOUNTS_QUERY = "{ actor { accounts { id } } }";

export interface DoctorDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  mcpTimeoutMs?: number;
}

export type NerdGraphStatus = { ok: true; accounts: number } | { ok: false; code: string; message: string };
export type McpStatus =
  | { status: "available" }
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
  const [nerdgraph, mcp] = await Promise.all([probeNerdGraph(region, apiKey, deps), probeMcp(mcpUrl, apiKey, deps)]);
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

/** POST MCP `initialize` with the `api-key` header: 200 + tools capability → available. */
export async function probeMcp(url: string, apiKey: string, deps: DoctorDeps = {}): Promise<McpStatus> {
  const timeoutMs = deps.mcpTimeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  let response: Response;
  let text: string;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "compozy-newrelic", version: "doctor" },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { status: "unknown", error: timedOut ? `no answer within ${timeoutMs / 1000}s` : "network error" };
  }
  if ([401, 403, 404].includes(response.status)) return { status: "unavailable", http: response.status };
  if (response.status !== 200) return { status: "unknown", error: `HTTP ${response.status}` };
  const message = parseRpc(text);
  const tools = message?.result?.capabilities?.tools;
  if (tools && typeof tools === "object") return { status: "available" };
  return { status: "unknown", error: message ? "no tools capability in initialize result" : "unexpected response" };
}

type RpcMessage = { result?: { capabilities?: { tools?: unknown } } };

/** Reads a JSON-RPC answer sent as plain JSON or as Streamable HTTP SSE `data:` lines. */
function parseRpc(text: string): RpcMessage | null {
  const candidates = [text, ...text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5))];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && "result" in parsed) return parsed as RpcMessage;
    } catch {
      // not JSON; try the next candidate
    }
  }
  return null;
}

/** Operator report, exactly the `_dx.md` Golden Path lines. */
export function formatReport(report: DoctorReport): string {
  const ng = report.nerdgraph;
  const nerdgraph = ng.ok
    ? `NerdGraph: ok (region ${report.region}, ${ng.accounts} account${ng.accounts === 1 ? "" : "s"} visible)`
    : `NerdGraph: failed (${ng.message})`;
  const server = report.region === "eu" ? "newrelic-eu" : "newrelic";
  const keepTools = "agents keep the ext__newrelic__* tools";
  const mcp =
    report.mcp.status === "available"
      ? `MCP: available — run \`compozy mcp auth login ${server}\` to give agents the official New Relic tools`
      : report.mcp.status === "unavailable"
        ? `MCP: unavailable (${report.mcp.http} from ${report.mcpUrl}) — ${keepTools}; skip the MCP login`
        : `MCP: unknown (${report.mcp.error}) — ${keepTools}; run the doctor again later`;
  return `${nerdgraph}\n${mcp}`;
}

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
