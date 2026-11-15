import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { fingerprint, sortRows, transition, type Signal } from "../engine.ts";
import { paramsError, sourceError } from "../errors.ts";
import { redactDeep, shapeItem } from "../items.ts";
import { accountError } from "../nerdgraph.ts";
import { sanitizeKey } from "../normalize.ts";
import { asObject, COMMON_PROPERTIES, parseCommon, stringListParam } from "../params.ts";
import type { ParsedParams, SourceContext, SourceDefinition } from "./source.ts";

/** Lowest to highest; the index is the ordering weight (Business Rule 6). */
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const OPEN_STATES = ["ACTIVATED", "CREATED"];
const ENTITY_GUID = /^[A-Za-z0-9+/=_-]{1,200}$/;
export const MAX_ISSUE_PAGES = 20;
const PAGES_MESSAGE = `more than ${MAX_ISSUE_PAGES} pages of open issues; narrow with.priorities or with.entity_guids`;

export interface IssuesParams extends ParsedParams {
  priorities: string[];
  entityGuids: string[];
}

export const ISSUES_PARAMS_SCHEMA: JSONValue = {
  type: "object",
  additionalProperties: false,
  required: ["account_id"],
  properties: {
    ...COMMON_PROPERTIES,
    priorities: {
      type: "array",
      items: { type: "string", enum: [...PRIORITIES] },
      minItems: 1,
      default: ["CRITICAL", "HIGH"],
    },
    entity_guids: {
      type: "array",
      items: { type: "string", pattern: ENTITY_GUID.source },
      maxItems: 100,
    },
  },
};

export function parseIssuesParams(raw: unknown): IssuesParams {
  const obj = asObject(raw);
  const common = parseCommon(obj);
  const priorities = stringListParam(obj.priorities, "priorities", {
    allowed: PRIORITIES,
    fallback: ["CRITICAL", "HIGH"],
    minItems: 1,
  });
  const entityGuids = stringListParam(obj.entity_guids, "entity_guids", { pattern: ENTITY_GUID, fallback: [] });
  const fp = fingerprint({
    kind: "issues",
    account_id: common.accountId,
    region: common.region,
    priorities,
    entity_guids: entityGuids,
  });
  return { ...common, priorities, entityGuids, fingerprint: fp };
}

const list = (values: string[]) => `[${values.map(value => JSON.stringify(value)).join(",")}]`;

/**
 * The `aiIssues` query (Deviation D-S2-a): filter and cursor are GraphQL literals because the input
 * type names are not publicly documented; strings are JSON-encoded, a subset of GraphQL escaping.
 */
export function issuesQuery(params: IssuesParams, cursor: string | null): string {
  const filter = [
    `states:[${OPEN_STATES.join(",")}]`,
    `priority:${list(params.priorities)}`,
    ...(params.entityGuids.length ? [`entityGuids:${list(params.entityGuids)}`] : []),
  ].join(",");
  const args = `filter:{${filter}}${cursor ? `,cursor:${JSON.stringify(cursor)}` : ""}`;
  return (
    "query($id:Int!){actor{account(id:$id){aiIssues{" +
    `issues(${args}){issues{issueId title priority state entityNames activatedAt createdAt} nextCursor}` +
    "}}}}"
  );
}

type IssuesData = {
  actor?: {
    account?: { aiIssues?: { issues?: { issues?: unknown; nextCursor?: unknown } | null } | null } | null;
  };
};

/** Every page of open issues, following `nextCursor` until it is empty (IT-002). */
export async function fetchIssues(params: IssuesParams, context: SourceContext): Promise<Record<string, unknown>[]> {
  const issues: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const query = issuesQuery(params, cursor);
    const data = await context.client.query<IssuesData>(query, { id: params.accountId }, context.signal);
    const account = data?.actor?.account;
    if (!account) throw accountError(params.accountId);
    const result = account.aiIssues?.issues;
    if (!result || !Array.isArray(result.issues)) throw sourceError("source_extension_failed", "New Relic request failed: unexpected response");
    issues.push(...result.issues.filter((row): row is Record<string, unknown> => !!row && typeof row === "object"));
    const next = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : null;
    if (next === null) return issues;
    cursor = next;
  }
  throw paramsError(PAGES_MESSAGE);
}

/** EpochMilliseconds, which NerdGraph may serialize as a number or a numeric string. */
export function epochMs(raw: unknown): number | null {
  const ms = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(ms) && ms < 1e13 ? ms : null; // < year 2286 keeps toISOString and ranks safe
}

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : typeof raw === "string" ? [raw] : [];

/** Business Rules 2–3, 6: open issues with a wanted priority, keyed by id, CRITICAL first then oldest. */
export function issuesSignals(
  rows: Record<string, unknown>[],
  params: IssuesParams,
  context: Pick<SourceContext, "endpoints" | "redact">
): Signal[] {
  const signals: Signal[] = [];
  for (const issue of sortRows(redactDeep(rows, context.redact))) {
    const id = typeof issue.issueId === "string" || typeof issue.issueId === "number" ? String(issue.issueId) : "";
    const priority = String(issue.priority ?? "");
    if (!id || !OPEN_STATES.includes(String(issue.state)) || !params.priorities.includes(priority)) continue;
    const openedMs = epochMs(issue.activatedAt) ?? epochMs(issue.createdAt);
    // Priority weight dominates; within a priority an older activation ranks higher (ms < 1e13).
    const rank = PRIORITIES.indexOf(priority as (typeof PRIORITIES)[number]) * 1e13 - (openedMs ?? 0);
    signals.push({ key: sanitizeKey(id), rank, item: issueItem(id, issue, priority, openedMs, params, context) });
  }
  return signals;
}

function issueItem(
  id: string,
  issue: Record<string, unknown>,
  priority: string,
  openedMs: number | null,
  params: IssuesParams,
  context: Pick<SourceContext, "endpoints">
) {
  const title = strings(issue.title).join("; ") || `issue ${id}`;
  const entities = strings(issue.entityNames).join(", ");
  const opened = openedMs === null ? null : new Date(openedMs).toISOString();
  const state = String(issue.state);
  return shapeItem({
    key: sanitizeKey(id),
    title: `${priority} issue: ${title}`,
    summary: [
      "New Relic alert issue",
      `account ${params.accountId} (${params.region})`,
      `priority ${priority}`,
      `state ${state}`,
      ...(entities ? [`entities: ${entities}`] : []),
      ...(opened ? [`activated ${opened}`] : []),
    ].join(" · "),
    url: context.endpoints.web,
    attributes: {
      kind: "issues",
      account_id: params.accountId,
      region: params.region,
      issue_id: id,
      priority,
      state,
      entities,
      activated_at: opened,
      title,
    },
    dropOrder: ["title", "entities"],
  });
}

async function pollIssues(
  request: HeartbeatSourceRequest,
  params: IssuesParams,
  context: SourceContext
): Promise<HeartbeatSourceResult> {
  const rows = await fetchIssues(params, context);
  return transition({
    committed: request.state,
    fingerprint: params.fingerprint,
    signals: issuesSignals(rows, params, context),
    notifyExisting: params.notifyExisting,
    limits: request.limits,
  });
}

export const issuesSource: SourceDefinition<IssuesParams> = {
  kind: "issues",
  title: "New Relic alert issues",
  description: "Wakes the agent when a New Relic alert issue with a wanted priority opens.",
  params_schema: ISSUES_PARAMS_SCHEMA,
  parse: parseIssuesParams,
  poll: pollIssues,
};
