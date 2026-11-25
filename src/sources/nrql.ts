import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { fingerprint, sortRows, transition, type Signal } from "../engine.ts";
import { paramsError, sourceError } from "../errors.ts";
import { formatNumber, isoUtc, redactDeep, shapeItem, truncateChars } from "../items.ts";
import { sanitizeKey } from "../normalize.ts";
import {
  accountFingerprint,
  accountsText,
  asObject,
  COMMON_PROPERTIES,
  parseCommon,
  requiredNumber,
  requiredString,
} from "../params.ts";
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
  required: ["nrql", "threshold"],
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
    ...accountFingerprint(common),
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

/**
 * The measured value of a row (D-11): the first numeric field that is neither the facet, a time bucket
 * nor a FACET attribute. An object value is read through `score` (apdex), its first percentile
 * (`{"percentile.duration": {"95": 2.31}}` reads as p95), or its only number; an object with several
 * numbers is ambiguous and fails with the shape message.
 */
export function readRow(row: Record<string, unknown>, facetFields: ReadonlySet<string> = new Set()): NrqlRowValue {
  const facet = facetOf(row);
  for (const [field, entry] of Object.entries(row)) {
    if (TIME_FIELDS.has(field) || facetFields.has(field)) continue;
    if (typeof entry === "number" || entry === null) return { facet, label: field, value: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const object = entry as Record<string, unknown>;
      if (typeof object.score === "number" || object.score === null) return { facet, label: field, value: object.score };
      const numbers = Object.entries(object).filter(([, inner]) => typeof inner === "number" || inner === null);
      const percentile = /^percentile\.(.+)$/.exec(field);
      if (numbers.length > 1 && !percentile) throw paramsError(SHAPE_MESSAGE);
      const [first] = numbers;
      if (first) {
        const label = percentile ? `p${first[0]} ${percentile[1]}` : `${field}.${first[0]}`;
        return { facet, label, value: first[1] as number | null };
      }
    }
  }
  throw paramsError(SHAPE_MESSAGE);
}

const FACET_END = /\b(?:SINCE|UNTIL|LIMIT|TIMESERIES|COMPARE|ORDER|WITH|EXTRAPOLATE|SLIDE)\b/i;

/** Attribute names and aliases listed in the query's FACET clause (D-11), skipped by `readRow`. */
export function facetFields(nrql: string): Set<string> {
  const fields = new Set<string>();
  const start = /\bFACET\b/i.exec(nrql);
  if (!start) return fields;
  let clause = nrql.slice(start.index + start[0].length);
  const end = FACET_END.exec(clause);
  if (end) clause = clause.slice(0, end.index);
  let depth = 0;
  let part = "";
  const parts: string[] = [];
  for (const ch of clause) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  parts.push(part);
  for (const raw of parts) {
    const unquote = (text: string) => text.trim().replace(/^[`'"]|[`'"]$/g, "");
    const aliased = /^([\s\S]*\S)\s+AS\s+([^\s()]+)\s*$/i.exec(raw.trim()); // the top-level alias is last
    const expr = unquote(aliased ? aliased[1]! : raw);
    if (expr && !expr.includes("(")) fields.add(expr);
    if (aliased) fields.add(unquote(aliased[2]!));
  }
  return fields;
}

/** A row's facet tuple (`facet` holds one value or an array), or null without FACET. */
export function facetOf(row: Record<string, unknown>): string[] | null {
  const raw = row.facet;
  return raw === undefined ? null : (Array.isArray(raw) ? raw : [raw]).map(part => String(part));
}

/**
 * The `count(*)` value of a counting row (errors, logs). Their NRQL is built by the extension, so a
 * missing count is an unexpected response, not a parameter problem (review R-3).
 */
export function countOf(row: Record<string, unknown>): number {
  if (typeof row.count !== "number") throw sourceError("source_extension_failed", "New Relic request failed: unexpected response");
  return row.count;
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
  const byKey = new Map<string, Signal>();
  const skip = facetFields(params.nrql);
  for (const row of sortRows(redactDeep(rows, context.redact))) {
    const read = readRow(row, skip);
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
  // D-22: never show a threshold and a different value as the same number.
  const [shownThreshold, shownValue] =
    formatNumber(params.threshold) === formatNumber(value) && params.threshold !== value
      ? [String(params.threshold), String(value)]
      : [formatNumber(params.threshold), formatNumber(value)];
  const breach = `${params.condition} ${shownThreshold}: ${shownValue}`;
  const title = facetText
    ? `${facetText} ${breach} (${read.label}, ${accountsText(params)})`
    : `${read.label} ${breach} (${accountsText(params)})`;
  const summary = [
    "NRQL threshold breach",
    `${accountsText(params)} (${params.region})`,
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
      ...(params.accountIds.length > 1 ? { account_ids: params.accountIds } : { account_id: params.accountId }),
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
  const rows = await context.client.nrql(params.accountIds, params.nrql, context.signal);
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
