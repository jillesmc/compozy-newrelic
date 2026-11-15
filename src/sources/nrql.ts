import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { canonicalJson, fingerprint, transition, type Signal } from "../engine.ts";
import { paramsError } from "../errors.ts";
import { formatNumber, isoUtc, redactDeep, shapeItem, truncateChars } from "../items.ts";
import { sanitizeKey } from "../normalize.ts";
import { asObject, COMMON_PROPERTIES, parseCommon, requiredNumber, requiredString } from "../params.ts";
import type { ParsedParams, SourceContext, SourceDefinition } from "./source.ts";

export interface NrqlParams extends ParsedParams {
  nrql: string;
  condition: "above" | "below";
  threshold: number;
}

export const MAX_NRQL_ROWS = 500;
/** No-facet key (Deviation D-2: the daemon rejects `_`). */
export const NO_FACET_KEY = "all";
const MAX_NRQL_ATTRIBUTE_CHARS = 500;
const SHAPE_MESSAGE = "nrql must return one number per row (e.g. SELECT count(*) ... FACET x)";
const ROWS_MESSAGE = `nrql returned more than ${MAX_NRQL_ROWS} rows; add LIMIT or narrow the FACET`;
// Time bucket fields of TIMESERIES / SELECT * rows are never the measured value.
const TIME_FIELDS = new Set(["facet", "beginTimeSeconds", "endTimeSeconds", "timestamp"]);

export const NRQL_PARAMS_SCHEMA: JSONValue = {
  type: "object",
  additionalProperties: false,
  required: ["account_id", "nrql", "threshold"],
  properties: {
    ...COMMON_PROPERTIES,
    nrql: { type: "string", minLength: 1, maxLength: 4000 },
    condition: { type: "string", enum: ["above", "below"], default: "above" },
    threshold: { type: "number" },
  },
};

export function parseNrqlParams(raw: unknown): NrqlParams {
  const obj = asObject(raw);
  const common = parseCommon(obj);
  const nrql = requiredString(obj.nrql, "nrql");
  const condition = obj.condition ?? "above";
  if (condition !== "above" && condition !== "below") throw paramsError("condition must be above or below");
  const threshold = requiredNumber(obj.threshold, "threshold");
  const fp = fingerprint({
    kind: "nrql",
    account_id: common.accountId,
    region: common.region,
    nrql,
    condition,
    threshold,
  });
  return { ...common, nrql, condition, threshold, fingerprint: fp };
}

/** One NRQL row reduced to its facet tuple and measured value (null = no data). */
export interface NrqlRowValue {
  facet: string[] | null;
  label: string;
  value: number | null;
}

/** First numeric non-facet field of a row; `{"percentile.duration": {"95": 2.31}}` reads as p95. */
export function readRow(row: Record<string, unknown>): NrqlRowValue {
  const rawFacet = row.facet;
  const facet =
    rawFacet === undefined ? null : (Array.isArray(rawFacet) ? rawFacet : [rawFacet]).map(part => String(part));
  // ponytail: a numeric FACET attribute listed before the aggregate would be read as the value;
  // parse the FACET clause if real queries hit it.
  for (const [field, entry] of Object.entries(row)) {
    if (TIME_FIELDS.has(field)) continue;
    if (typeof entry === "number" || entry === null) return { facet, label: field, value: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = Object.entries(entry).find(([, inner]) => typeof inner === "number" || inner === null);
      if (nested) return { facet, label: nestedLabel(field, nested[0]), value: nested[1] as number | null };
    }
  }
  throw paramsError(SHAPE_MESSAGE);
}

function nestedLabel(field: string, inner: string): string {
  const percentile = /^percentile\.(.+)$/.exec(field);
  return percentile ? `p${inner} ${percentile[1]}` : `${field}.${inner}`;
}

export function nrqlKey(facet: string[] | null): string {
  return sanitizeKey(facet ? facet.join("/") : NO_FACET_KEY);
}

/** Rows → active signals, independent of row order (Business Rules 2, 3, 12). */
export function nrqlSignals(
  rows: Record<string, unknown>[],
  params: NrqlParams,
  request: Pick<HeartbeatSourceRequest, "now">,
  context: Pick<SourceContext, "endpoints" | "redact">
): Signal[] {
  if (rows.length > MAX_NRQL_ROWS) throw paramsError(ROWS_MESSAGE);
  const sorted = redactDeep(rows, context.redact)
    .map(row => ({ row, text: canonicalJson(row) }))
    .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const byKey = new Map<string, Signal>();
  for (const { row } of sorted) {
    const read = readRow(row);
    if (read.value === null) continue;
    const margin = params.condition === "above" ? read.value - params.threshold : params.threshold - read.value;
    if (!(margin > 0)) continue;
    const key = nrqlKey(read.facet);
    const previous = byKey.get(key);
    if (previous && previous.rank >= margin) continue;
    byKey.set(key, { key, rank: margin, item: nrqlItem(key, read, read.value, params, request.now, context) });
  }
  return [...byKey.values()];
}

function nrqlItem(
  key: string,
  read: NrqlRowValue,
  value: number,
  params: NrqlParams,
  now: string,
  context: Pick<SourceContext, "endpoints" | "redact">
) {
  const facetText = read.facet ? read.facet.join("/") : null;
  const breach = `${params.condition} ${formatNumber(params.threshold)}: ${formatNumber(value)}`;
  const title = facetText
    ? `${facetText} ${breach} (${read.label}, account ${params.accountId})`
    : `${read.label} ${breach} (account ${params.accountId})`;
  const summary = [
    "NRQL threshold breach",
    `account ${params.accountId} (${params.region})`,
    `${read.label} ${breach}`,
    ...(facetText ? [`facet: ${facetText}`] : []),
    `checked ${isoUtc(now)}`,
  ].join(" · ");
  return shapeItem({
    key,
    title,
    summary,
    url: context.endpoints.web,
    attributes: {
      kind: "nrql",
      account_id: params.accountId,
      region: params.region,
      condition: params.condition,
      threshold: params.threshold,
      value,
      field: read.label,
      facet: facetText,
      nrql: truncateChars(context.redact(params.nrql), MAX_NRQL_ATTRIBUTE_CHARS),
    },
    dropOrder: ["nrql"],
  });
}

async function pollNrql(
  request: HeartbeatSourceRequest,
  params: NrqlParams,
  context: SourceContext
): Promise<HeartbeatSourceResult> {
  const rows = await context.client.nrql(params.accountId, params.nrql, context.signal);
  return transition({
    committed: request.state,
    fingerprint: params.fingerprint,
    signals: nrqlSignals(rows, params, request, context),
    notifyExisting: params.notifyExisting,
    limits: request.limits,
  });
}

export const nrqlSource: SourceDefinition<NrqlParams> = {
  kind: "nrql",
  title: "NRQL threshold",
  description: "Wakes the agent when a NRQL value (per facet) starts breaching a threshold.",
  params_schema: NRQL_PARAMS_SCHEMA,
  parse: parseNrqlParams,
  poll: pollNrql,
};
