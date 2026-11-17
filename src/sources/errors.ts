import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { fingerprint, sortRows, transition, type Signal } from "../engine.ts";
import { paramsError } from "../errors.ts";
import { formatNumber, isoUtc, redactDeep, shapeItem } from "../items.ts";
import { normalizeMessage, sanitizeKey, sha256Hex } from "../normalize.ts";
import {
  asObject,
  COMMON_PROPERTIES,
  integerParam,
  parseCommon,
  parseWindow,
  sinceClause,
  stringListParam,
  WINDOW_PATTERN,
} from "../params.ts";
import { countOf, facetOf, MAX_NRQL_ROWS } from "./nrql.ts";
import type { ParsedParams, SourceContext, SourceDefinition } from "./source.ts";

export const ERROR_EVENT_TYPES = ["JavaScriptError", "TransactionError"] as const;

export interface ErrorsParams extends ParsedParams {
  where: string | null;
  eventTypes: string[];
  windowMinutes: number;
  windowText: string;
  minCount: number;
}

export const ERRORS_PARAMS_SCHEMA: JSONValue = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...COMMON_PROPERTIES,
    where: { type: "string", minLength: 1, maxLength: 4000 },
    event_types: {
      type: "array",
      items: { type: "string", enum: [...ERROR_EVENT_TYPES] },
      minItems: 1,
      default: ["TransactionError"],
    },
    window: { type: "string", pattern: WINDOW_PATTERN, default: "30m" },
    min_count: { type: "integer", minimum: 1, default: 1 },
  },
};

export function parseErrorsParams(raw: unknown): ErrorsParams {
  const obj = asObject(raw);
  const common = parseCommon(obj);
  if (obj.where !== undefined && (typeof obj.where !== "string" || obj.where.length > 4000)) {
    throw paramsError("with.where must be a NRQL WHERE body of at most 4000 characters");
  }
  const where = typeof obj.where === "string" && obj.where.trim() !== "" ? obj.where.trim() : null;
  const eventTypes = stringListParam(obj.event_types, "event_types", {
    allowed: ERROR_EVENT_TYPES,
    fallback: ["TransactionError"],
    minItems: 1,
  });
  const windowText = typeof obj.window === "string" ? obj.window : "30m";
  const windowMinutes = parseWindow(obj.window, "30m");
  const minCount = integerParam(obj.min_count, "min_count", 1, 1);
  const fp = fingerprint({
    kind: "errors",
    account_id: common.accountId,
    region: common.region,
    where,
    event_types: eventTypes,
    window: windowMinutes,
    min_count: minCount,
  });
  return { ...common, where, eventTypes, windowMinutes, windowText, minCount, fingerprint: fp };
}

export function errorsNrql(params: ErrorsParams): string {
  return [
    `SELECT count(*) FROM ${params.eventTypes.join(", ")}`,
    ...(params.where ? [`WHERE ${params.where}`] : []),
    "FACET appName, error.class, error.message",
    sinceClause(params.windowMinutes),
    `LIMIT ${MAX_NRQL_ROWS + 1}`, // one extra row makes truncation detectable (D-S2-c)
  ].join(" ");
}

interface ErrorType {
  key: string;
  app: string;
  errorClass: string;
  message: string;
  count: number;
}

/** Business Rules 3–4: rows regrouped by app, class and normalized message, counts summed. */
export function errorTypes(rows: Record<string, unknown>[], redact: (text: string) => string): ErrorType[] {
  if (rows.length > MAX_NRQL_ROWS) {
    throw paramsError(`errors returned more than ${MAX_NRQL_ROWS} rows; narrow with.where`);
  }
  const byKey = new Map<string, ErrorType>();
  for (const row of sortRows(redactDeep(rows, redact))) {
    const [app = "unknown", errorClass = "unknown", rawMessage = ""] = facetOf(row) ?? [];
    const message = normalizeMessage(rawMessage);
    const key = sanitizeKey(`${app}/${errorClass}/${sha256Hex(message).slice(0, 8)}`);
    const entry = byKey.get(key) ?? { key, app, errorClass, message, count: 0 };
    entry.count += countOf(row);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

export function errorsSignals(
  rows: Record<string, unknown>[],
  params: ErrorsParams,
  request: Pick<HeartbeatSourceRequest, "now">,
  context: Pick<SourceContext, "endpoints" | "redact">
): Signal[] {
  return errorTypes(rows, context.redact)
    .filter(type => type.count >= params.minCount)
    .map(type => ({ key: type.key, rank: type.count - params.minCount, item: errorsItem(type, params, request.now, context) }));
}

function errorsItem(
  type: ErrorType,
  params: ErrorsParams,
  now: string,
  context: Pick<SourceContext, "endpoints">
) {
  const count = formatNumber(type.count);
  return shapeItem({
    key: type.key,
    title: `${type.errorClass} in ${type.app}: ${count} in ${params.windowText}`,
    summary: [
      "New error type",
      `account ${params.accountId} (${params.region})`,
      `${count} in ${params.windowText} (min ${params.minCount})`,
      `checked ${isoUtc(now)}`,
      `message: ${type.message}`,
    ].join(" · "),
    url: context.endpoints.web ? `${context.endpoints.web}/errors-inbox` : undefined,
    attributes: {
      kind: "errors",
      account_id: params.accountId,
      region: params.region,
      app: type.app,
      class: type.errorClass,
      message: type.message,
      count: type.count,
      window: params.windowText,
      min_count: params.minCount,
    },
    dropOrder: ["message"],
  });
}

async function pollErrors(
  request: HeartbeatSourceRequest,
  params: ErrorsParams,
  context: SourceContext
): Promise<HeartbeatSourceResult> {
  const rows = await context.client.nrql(params.accountId, errorsNrql(params), context.signal);
  return transition({
    committed: request.state,
    fingerprint: params.fingerprint,
    signals: errorsSignals(rows, params, request, context),
    notifyExisting: params.notifyExisting,
    limits: request.limits,
  });
}

export const errorsSource: SourceDefinition<ErrorsParams> = {
  kind: "errors",
  title: "New errors",
  description: "Wakes the agent when an error type (app, class, normalized message) reaches a count in a window.",
  params_schema: ERRORS_PARAMS_SCHEMA,
  parse: parseErrorsParams,
  poll: pollErrors,
};
