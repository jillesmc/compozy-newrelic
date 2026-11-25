import { paramsError } from "../errors.ts";
import { isoUtc, truncateChars } from "../items.ts";
import { normalizeMessage } from "../normalize.ts";
import { parseWindow, requiredString, sinceClause } from "../params.ts";
import { boundedResult, cell, flattenRow, renderLines, renderTable, type Row } from "./format.ts";
import {
  ACCOUNT_PROPERTIES,
  accountId,
  accountIds,
  APP_PROPERTY,
  MULTI_ACCOUNT_PROPERTIES,
  type NerdGraphTool,
} from "./tool.ts";

export const MAX_NRQL_ROWS = 50;
export const MAX_GROUPS = 25;
const MAX_FACET_ROWS = 500;
export const MAX_LOG_LINES = 50;
export const MAX_LOG_CHARS = 300;

export const nrqlQueryTool: NerdGraphTool = {
  name: "nrql_query",
  project: true,
  multiAccount: true,
  description:
    "Run a read-only NRQL query against one New Relic account, or several at once with account_ids " +
    "(add FACET accountId() to split rows by account), and return up to 50 rows as a compact table.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["nrql"],
    properties: { ...MULTI_ACCOUNT_PROPERTIES, nrql: { type: "string", minLength: 1, maxLength: 4000 } },
  },
  async run(input, ctx) {
    const nrql = requiredString(input.nrql, "nrql");
    const results = (await ctx.client.nrql(accountIds(input), nrql, ctx.signal)).map(flattenRow);
    const columns = [...new Set(results.flatMap(row => Object.keys(row)))];
    const rows = results.map(row => Object.fromEntries(columns.map(column => [column, cell(row[column])])));
    return boundedResult({ rows, cap: MAX_NRQL_ROWS, columns, render: renderTable });
  },
};

export const errorGroupsTool: NerdGraphTool = {
  name: "error_groups",
  project: true,
  description:
    "Group recent TransactionError events by app, error class and normalized message; up to 25 groups, most frequent first.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...ACCOUNT_PROPERTIES,
      app: APP_PROPERTY,
      where: { type: "string", maxLength: 4000, description: "NRQL WHERE body, without the WHERE keyword" },
      window: { type: "string", pattern: "^[0-9]+(m|h)$", default: "30m" },
    },
  },
  async run(input, ctx) {
    const where = optionalWhere(input.where);
    const minutes = parseWindow(input.window, "30m");
    const nrql =
      `SELECT count(*), max(timestamp) FROM TransactionError${where ? ` WHERE ${where}` : ""} ` +
      `FACET appName, error.class, error.message ${sinceClause(minutes)} LIMIT ${MAX_FACET_ROWS + 1}`;
    // One extra row makes a cut detectable (as D-9 does for the sources, review R-4).
    const results = await ctx.client.nrql(accountId(input), nrql, ctx.signal);
    const more = results.length > MAX_FACET_ROWS;
    const groups = new Map<string, { app: string; class: string; message: string; count: number; last: number }>();
    for (const row of results.slice(0, MAX_FACET_ROWS)) {
      const facet = Array.isArray(row.facet) ? row.facet : [];
      const [app, errorClass, message] = [0, 1, 2].map(i => (facet[i] === null || facet[i] === undefined ? "" : String(facet[i])));
      const normalized = normalizeMessage(message ?? "");
      const id = JSON.stringify([app, errorClass, normalized]);
      const group = groups.get(id) ?? { app: app ?? "", class: errorClass ?? "", message: normalized, count: 0, last: 0 };
      group.count += Number(row.count) || 0;
      group.last = Math.max(group.last, Number(row["max.timestamp"]) || 0);
      groups.set(id, group);
    }
    const rows: Row[] = [...groups.entries()]
      .sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))
      .map(([, group]) => ({
        app: group.app,
        class: group.class,
        message: group.message,
        count: group.count,
        last_seen: group.last ? new Date(group.last).toISOString() : null,
      }));
    const columns = ["app", "class", "count", "last_seen", "message"];
    return boundedResult({ rows, cap: MAX_GROUPS, more, render: shown => renderLines(shown, columns) });
  },
};

export const recentLogsTool: NerdGraphTool = {
  name: "recent_logs",
  project: true,
  multiAccount: true,
  description:
    "Return the most recent New Relic log lines matching a NRQL WHERE filter, from one account or several " +
    "with account_ids: at most 50 lines, each message cut to 300 characters.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["where"],
    properties: {
      ...MULTI_ACCOUNT_PROPERTIES,
      app: APP_PROPERTY,
      where: { type: "string", minLength: 1, maxLength: 4000, description: "NRQL WHERE body over Log" },
      window: { type: "string", pattern: "^[0-9]+(m|h)$", default: "15m" },
      limit: { type: "integer", minimum: 1, maximum: MAX_LOG_LINES, default: 20 },
    },
  },
  async run(input, ctx) {
    const where = requiredString(input.where, "where");
    const minutes = parseWindow(input.window, "15m");
    const limit = input.limit ?? 20;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LINES) {
      throw paramsError(`limit must be an integer from 1 to ${MAX_LOG_LINES}`);
    }
    const nrql = `SELECT timestamp, service.name, level, message FROM Log WHERE ${where} ${sinceClause(minutes)} LIMIT ${limit}`;
    const results = await ctx.client.nrql(accountIds(input), nrql, ctx.signal);
    const rows: Row[] = results.map(row => ({
      timestamp: typeof row.timestamp === "number" ? new Date(row.timestamp).toISOString() : isoUtc(String(row.timestamp ?? "")),
      service: cell(row["service.name"]),
      level: cell(row.level),
      message: truncateChars(typeof row.message === "string" ? row.message : JSON.stringify(row.message ?? ""), MAX_LOG_CHARS),
    }));
    const columns = ["timestamp", "service", "level", "message"];
    return boundedResult({ rows, cap: limit, render: shown => renderLines(shown, columns) });
  },
};

function optionalWhere(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return requiredString(raw, "where");
}
