import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { fingerprint, sortRows, transition, type Signal } from "../engine.ts";
import { paramsError } from "../errors.ts";
import { epochMs, fetchIssuePages, issuesQuery as sharedIssuesQuery, type IssueFilter } from "../issue-query.ts";
import { redactDeep, shapeItem } from "../items.ts";
import { issueUrl } from "../nerdgraph.ts";
import { sanitizeKey } from "../normalize.ts";
import { asObject, COMMON_PROPERTIES, parseCommon, stringListParam } from "../params.ts";
import type { ParsedParams, SourceContext, SourceDefinition } from "./source.ts";

export { epochMs };

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

/** The shared `aiIssues` query (D-4) for open issues with these priorities and entities. */
export function issuesQuery(params: IssuesParams, cursor: string | null): string {
  return sharedIssuesQuery(issueFilter(params), cursor);
}

function issueFilter(params: IssuesParams): IssueFilter {
  return { states: OPEN_STATES, priorities: params.priorities, entityGuids: params.entityGuids };
}

/** Every page of open issues, following `nextCursor` until it is empty (IT-002). */
export async function fetchIssues(params: IssuesParams, context: SourceContext): Promise<Record<string, unknown>[]> {
  const { issues, more } = await fetchIssuePages(
    context.client, params.accountId, issueFilter(params), context.signal, MAX_ISSUE_PAGES
  );
  if (more) throw paramsError(PAGES_MESSAGE);
  return issues;
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
    url: issueUrl(context.endpoints, params.accountId, id) ?? context.endpoints.web,
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
