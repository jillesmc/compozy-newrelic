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

/**
 * Builds a bounded ToolResult (rows arrive redacted, see tool.ts): rows are capped at `cap`, then trailing rows are dropped
 * until both the text and the structured JSON fit 8 KiB; `truncated` reports any cut.
 */
export function boundedResult(input: {
  rows: Row[];
  cap: number;
  render: (rows: Row[]) => string;
  /** The source had more rows than were fetched. */
  more?: boolean;
}): ToolResult {
  let rows = input.rows;
  let truncated = !!input.more || rows.length > input.cap;
  rows = rows.slice(0, input.cap);
  const build = () => {
    const structured: JSONValue = { rows, truncated };
    const text = `${input.render(rows) || "(no rows)"}${truncated ? "\n(truncated)" : ""}`;
    return { structured, text };
  };
  let out = build();
  while (rows.length > 0 && (byteLength(out.text) > MAX_TOOL_BYTES || byteLength(JSON.stringify(out.structured)) > MAX_TOOL_BYTES)) {
    rows = rows.slice(0, -1);
    truncated = true;
    out = build();
  }
  return {
    content: [{ type: "text", text: out.text }],
    structured: out.structured,
    truncated,
    bytes: byteLength(out.text),
    duration_ms: 0,
  };
}
