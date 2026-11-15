import { RPCError, type JSONValue, type ToolResult } from "@compozy/extension-sdk";

import { SourceError } from "../errors.ts";
import { byteLength, truncateChars } from "../items.ts";

/** Tool text and structured output bound (Business Rule 10, US-008.AC-2). */
export const MAX_TOOL_BYTES = 8192;
const MAX_CELL_CHARS = 300;

export type Row = Record<string, JSONValue>;

/** Tool failure: JSON-RPC -32000 with `data.code` = the source code without `source_` (_dx.md Errors). */
export function toolError(error: unknown): RPCError {
  if (error instanceof SourceError) {
    return new RPCError(-32000, error.message, { code: String(error.data?.code ?? "").replace(/^source_/, "") });
  }
  return new RPCError(-32000, "New Relic tool failed unexpectedly", { code: "extension_failed" });
}

/** Flattens a NerdGraph value into one compact cell (objects/arrays as JSON), ≤ 300 characters. */
export function cell(value: unknown): JSONValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncateChars(text, MAX_CELL_CHARS);
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
