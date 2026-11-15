import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { fingerprint, sortRows, transition, type Signal } from "../engine.ts";
import { paramsError } from "../errors.ts";
import { formatNumber, isoUtc, redactDeep, shapeItem, truncateChars } from "../items.ts";
import {
  asObject,
  COMMON_PROPERTIES,
  integerParam,
  parseCommon,
  parseWindow,
  requiredString,
  sinceClause,
  WINDOW_PATTERN,
} from "../params.ts";
import { countOf, facetOf, MAX_NRQL_ROWS, nrqlKey } from "./nrql.ts";
import type { ParsedParams, SourceContext, SourceDefinition } from "./source.ts";

export interface LogsParams extends ParsedParams {
  where: string;
  facet: string | null;
  windowMinutes: number;
  windowText: string;
  threshold: number;
}

const MAX_WHERE_ATTRIBUTE_CHARS = 300;

export const LOGS_PARAMS_SCHEMA: JSONValue = {
  type: "object",
  additionalProperties: false,
  required: ["account_id", "where", "threshold"],
  properties: {
    ...COMMON_PROPERTIES,
    where: { type: "string", minLength: 1, maxLength: 4000 },
    facet: { type: "string", minLength: 1, maxLength: 200 },
    window: { type: "string", pattern: WINDOW_PATTERN, default: "15m" },
    threshold: { type: "integer", minimum: 0 },
  },
};

export function parseLogsParams(raw: unknown): LogsParams {
  const obj = asObject(raw);
  const common = parseCommon(obj);
  const where = requiredString(obj.where, "where");
  const facet = obj.facet === undefined ? null : requiredString(obj.facet, "facet", 200);
  const windowText = typeof obj.window === "string" ? obj.window : "15m";
  const windowMinutes = parseWindow(obj.window, "15m");
  const threshold = integerParam(obj.threshold, "threshold", 0);
  const fp = fingerprint({
    kind: "logs",
    account_id: common.accountId,
    region: common.region,
    where,
    facet,
    window: windowMinutes,
    threshold,
  });
  return { ...common, where, facet, windowMinutes, windowText, threshold, fingerprint: fp };
}

export function logsNrql(params: LogsParams): string {
  return [
    `SELECT count(*) FROM Log WHERE ${params.where}`,
    ...(params.facet ? [`FACET ${params.facet}`] : []),
    sinceClause(params.windowMinutes),
    `LIMIT ${MAX_NRQL_ROWS + 1}`, // one extra row makes truncation detectable (D-S2-c)
  ].join(" ");
}

/** Business Rules 2–3: a group is active when its count is strictly above the threshold. */
export function logsSignals(
  rows: Record<string, unknown>[],
  params: LogsParams,
  request: Pick<HeartbeatSourceRequest, "now">,
  context: Pick<SourceContext, "endpoints" | "redact">
): Signal[] {
  if (rows.length > MAX_NRQL_ROWS) {
    throw paramsError(`logs returned more than ${MAX_NRQL_ROWS} rows; narrow with.where or with.facet`);
  }
  const byKey = new Map<string, Signal>();
  for (const row of sortRows(redactDeep(rows, context.redact))) {
    const count = countOf(row);
    const facet = facetOf(row);
    if (!(count > params.threshold)) continue;
    // Only the facet value is kept: log rows never contribute raw line text (Business Rule 10).
    const group = params.facet && facet ? facet.join("/") : null;
    const key = nrqlKey(group === null ? null : [group]);
    const previous = byKey.get(key);
    if (previous && previous.rank >= count - params.threshold) continue;
    byKey.set(key, { key, rank: count - params.threshold, item: logsItem(key, group, count, params, request.now, context) });
  }
  return [...byKey.values()];
}

function logsItem(
  key: string,
  group: string | null,
  count: number,
  params: LogsParams,
  now: string,
  context: Pick<SourceContext, "endpoints" | "redact">
) {
  const lines = `${formatNumber(count)} log lines in ${params.windowText} (threshold ${params.threshold})`;
  return shapeItem({
    key,
    title: `${group ?? "all logs"}: ${lines}`,
    summary: [
      "Log spike",
      `account ${params.accountId} (${params.region})`,
      lines,
      ...(group !== null ? [`${params.facet}: ${group}`] : []),
      `checked ${isoUtc(now)}`,
    ].join(" · "),
    url: context.endpoints.web,
    attributes: {
      kind: "logs",
      account_id: params.accountId,
      region: params.region,
      facet: params.facet,
      group,
      count,
      window: params.windowText,
      threshold: params.threshold,
      where: truncateChars(context.redact(params.where), MAX_WHERE_ATTRIBUTE_CHARS),
    },
    dropOrder: ["where"],
  });
}

async function pollLogs(
  request: HeartbeatSourceRequest,
  params: LogsParams,
  context: SourceContext
): Promise<HeartbeatSourceResult> {
  const rows = await context.client.nrql(params.accountId, logsNrql(params), context.signal);
  return transition({
    committed: request.state,
    fingerprint: params.fingerprint,
    signals: logsSignals(rows, params, request, context),
    notifyExisting: params.notifyExisting,
    limits: request.limits,
  });
}

export const logsSource: SourceDefinition<LogsParams> = {
  kind: "logs",
  title: "Log spikes",
  description: "Wakes the agent when a log group (optionally per facet) starts exceeding a count in a window.",
  params_schema: LOGS_PARAMS_SCHEMA,
  parse: parseLogsParams,
  poll: pollLogs,
};
