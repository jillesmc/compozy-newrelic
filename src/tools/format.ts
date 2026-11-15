import { RPCError, type JSONValue, type ToolResult } from "@compozy/extension-sdk";

import { byteLength, truncateChars } from "../items.ts";

/** Tool text and structured output bound (Business Rule 10, US-008.AC-2). */
export const MAX_TOOL_BYTES = 8192;
const MAX_CELL_CHARS = 300;

export type Row = Record<string, JSONValue>;

/** CompozyOS 0.7.0 keeps an extension tool error only with one of its own tool_* codes (Deviation D-18). */
const TOOL_CODES: Record<string, string> = {
  params_invalid: "tool_invalid_input",
  mcp_tool_not_exposed: "tool_denied",
  mcp_unavailable: "tool_unavailable",
  credential_absent: "tool_unavailable",
  credential_expired: "tool_unavailable",
  rate_limited: "tool_unavailable",
};
const TIMEOUT = /no answer within|budget exceeded|timed out/i;
const DOCTOR = "compozy extension exec newrelic --cmd doctor";
/** Next step per extension code; an error may carry its own `data.recovery` (proxy refusals). */
const RECOVERY: Record<string, string> = {
  params_invalid: "fix the named parameter and call the tool again",
  mcp_tool_not_exposed: "call ext__newrelic__mcp_tools to list callable tools",
  mcp_unavailable: "use the ext__newrelic__* NerdGraph tools",
  credential_absent: "run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY",
  credential_expired: "bind a User API key (NRAK-...) with compozy extension secrets set newrelic --env NEW_RELIC_API_KEY",
  rate_limited: "retry later",
};
const TIMEOUT_RECOVERY = "retry with a narrower query or time window";
const BACKEND_RECOVERY = `retry later; if it keeps failing, run ${DOCTOR}`;
const MAX_ERROR_CHARS = 1000;

/**
 * Tool failure: JSON-RPC -32000 whose `data` is a CompozyOS ToolError
 * `{code: tool_*, message, operator: {cause, recovery}}` (Deviation D-18). CompozyOS shows agents the
 * code, a generic text, and `operator.cause` / `operator.recovery`; the cause is the extension code
 * (and refusal reason) plus the `_dx.md` text: `mcp_tool_not_exposed (oauth_only): <text>`. Source
 * errors keep `source_*` (poll.ts).
 */
export function toolError(error: unknown): RPCError {
  let code = "extension_failed";
  let reason: unknown;
  let recovery: unknown;
  let text = "New Relic tool failed unexpectedly";
  if (error instanceof RPCError) {
    const data = (error.data ?? {}) as { code?: unknown; reason?: unknown; recovery?: unknown };
    code = String(data.code ?? code).replace(/^source_/, "");
    reason = data.reason;
    recovery = data.recovery;
    text = error.message;
  }
  const timedOut = TIMEOUT.test(text);
  const toolCode = TOOL_CODES[code] ?? (timedOut ? "tool_timed_out" : "tool_backend_failed");
  const message = truncateChars(`${code}${typeof reason === "string" ? ` (${reason})` : ""}: ${text}`, MAX_ERROR_CHARS);
  const next = typeof recovery === "string" && recovery.trim() ? recovery : RECOVERY[code] ?? (timedOut ? TIMEOUT_RECOVERY : BACKEND_RECOVERY);
  const operator = { cause: message, recovery: truncateChars(next, MAX_ERROR_CHARS) };
  return new RPCError(-32000, message, { code: toolCode, message, operator });
}

/** Flattens a NerdGraph value into one compact cell (objects/arrays as JSON), ≤ 300 characters. */
export function cell(value: unknown): JSONValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncateChars(text, MAX_CELL_CHARS);
}

/** Nested-object levels `flattenRow` expands into dotted keys (US-108). */
export const MAX_FLATTEN_DEPTH = 3;

/**
 * Flattens nested objects into dotted keys, `{"percentile.duration": {"95": 2.31}}` →
 * `{"percentile.duration.95": 2.31}`, expanding up to MAX_FLATTEN_DEPTH levels. Deeper values, arrays
 * and empty objects stay as they are (and `cell` renders them as compact JSON).
 */
export function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (key: string, value: unknown, level: number): void => {
    const nested = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
    if (nested && level < MAX_FLATTEN_DEPTH) {
      for (const [inner, child] of Object.entries(value)) walk(`${key}.${inner}`, child, level + 1);
    } else out[key] = value;
  };
  for (const [key, value] of Object.entries(row)) walk(key, value, 0);
  return out;
}

/** One row per line, `col=value` pairs joined by ` | `; `columns` fixes the order. */
export function renderLines(rows: Row[], columns: string[]): string {
  return rows
    .map(row => columns.filter(column => row[column] !== null && row[column] !== undefined)
      .map(column => `${column}=${typeof row[column] === "string" ? row[column] : JSON.stringify(row[column])}`)
      .join(" | "))
    .join("\n");
}

/** Pipe table with a header line, for NRQL results. */
export function renderTable(rows: Row[], columns: string[]): string {
  const value = (entry: JSONValue | undefined) =>
    entry === null || entry === undefined ? "" : typeof entry === "string" ? entry : JSON.stringify(entry);
  return [columns.join(" | "), ...rows.map(row => columns.map(column => value(row[column])).join(" | "))].join("\n");
}

/** Cell clip levels tried, loosest first, before a row is dropped (review R-2). */
const CLIP_LEVELS = [Infinity, 100, 40, 10];

/**
 * Builds a bounded ToolResult (rows arrive redacted, see tool.ts) whose text and structured JSON both
 * fit 8 KiB. Rows are capped at `cap`. With `columns` (tables), only the leading columns that fit with
 * one hardest-clipped row are kept. Then the most rows are kept, clipping cells harder before dropping
 * the last row, so one wide row still returns clipped data. `truncated` reports any cut.
 */
export function boundedResult(input: {
  rows: Row[];
  cap: number;
  render: (rows: Row[], columns: string[]) => string;
  /** Table columns, in order; omitted for line renderers. */
  columns?: string[];
  /** The source had more rows than were fetched. */
  more?: boolean;
}): ToolResult {
  const all = input.rows.slice(0, input.cap);
  const allColumns = input.columns ?? [];
  const build = (count: number, clip: number, width: number) => {
    const columns = allColumns.slice(0, width);
    const rows = all.slice(0, count).map(row => {
      const kept = input.columns ? Object.fromEntries(columns.map(column => [column, row[column] ?? null])) : row;
      return clip === Infinity ? kept : clipRow(kept, clip);
    });
    const truncated =
      !!input.more || input.rows.length > input.cap || count < all.length || width < allColumns.length || clip !== Infinity;
    const structured: JSONValue = { rows, truncated };
    const text = `${input.render(rows, columns) || "(no rows)"}${truncated ? "\n(truncated)" : ""}`;
    return { structured, text, truncated };
  };
  const fits = (out: ReturnType<typeof build>) =>
    byteLength(out.text) <= MAX_TOOL_BYTES && byteLength(JSON.stringify(out.structured)) <= MAX_TOOL_BYTES;
  const hardest = CLIP_LEVELS[CLIP_LEVELS.length - 1]!;
  // Widest column prefix that fits with one hardest-clipped row (fit shrinks monotonically with width).
  let low = 0;
  let high = allColumns.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(build(Math.min(1, all.length), hardest, mid))) low = mid;
    else high = mid - 1;
  }
  let out = build(0, Infinity, low);
  search: for (let count = all.length; count >= 1; count--) {
    for (const clip of CLIP_LEVELS) {
      const candidate = build(count, clip, low);
      if (fits(candidate)) {
        out = candidate;
        break search;
      }
    }
  }
  if (!fits(out)) out = { structured: { rows: [], truncated: true }, text: "(no rows)\n(truncated)", truncated: true };
  return {
    content: [{ type: "text", text: out.text }],
    structured: out.structured,
    truncated: out.truncated,
    bytes: byteLength(out.text),
    duration_ms: 0,
  };
}

function clipRow(row: Row, max: number): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? truncateChars(value, max) : value]));
}
