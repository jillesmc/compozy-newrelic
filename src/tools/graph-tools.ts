import { paramsError } from "../errors.ts";
import { epochMs, fetchIssuePages } from "../issue-query.ts";
import { parseWindow } from "../params.ts";
import { boundedResult, cell, renderLines, type Row } from "./format.ts";
import { ACCOUNT_PROPERTIES, accountId, REGION_PROPERTY, type NerdGraphTool } from "./tool.ts";

export const MAX_ACCOUNTS = 50;
export const MAX_ENTITIES = 25;
export const MAX_ISSUES = 25;
const MAX_ISSUE_PAGES = 4;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const STATES: Record<string, string[] | null> = {
  open: ["ACTIVATED", "CREATED"],
  closed: ["CLOSED", "DEACTIVATED"],
  all: null,
};

export const ACCOUNTS_QUERY = "{actor{accounts{id name}}}";
export const ENTITY_SEARCH_QUERY =
  "query($q:String!){actor{entitySearch(query:$q){results{entities{guid name type domain alertSeverity}}}}}";

export const listAccountsTool: NerdGraphTool = {
  name: "list_accounts",
  description: "List the New Relic accounts the bound API key can read (up to 50 `{id, name}`).",
  inputSchema: { type: "object", additionalProperties: false, properties: { region: REGION_PROPERTY } },
  async run(_input, ctx) {
    const data = await ctx.client.query<{ actor?: { accounts?: unknown[] } }>(ACCOUNTS_QUERY, {}, ctx.signal);
    const rows: Row[] = (data?.actor?.accounts ?? []).map(raw => {
      const account = (raw ?? {}) as Record<string, unknown>;
      return { id: cell(account.id), name: cell(account.name) };
    });
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    return boundedResult({ rows, cap: MAX_ACCOUNTS, render: shown => renderLines(shown, ["id", "name"]) });
  },
};

/** A bare name becomes `name LIKE '<name>'`; text with an operator is passed as NerdGraph entity search. */
export function entitySearchQuery(query: string): string {
  if (/=|\bLIKE\b|\bIN\b/i.test(query)) return query;
  return `name LIKE '${query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const searchEntitiesTool: NerdGraphTool = {
  name: "search_entities",
  description:
    "Find New Relic entities by name (or a NerdGraph entity search like `domain = 'APM' AND name LIKE 'checkout'`); up to 25 results.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: { query: { type: "string", minLength: 1, maxLength: 1000 }, region: REGION_PROPERTY },
  },
  async run(input, ctx) {
    if (typeof input.query !== "string" || !input.query.trim()) throw paramsError("set query to an entity name");
    type Data = { actor?: { entitySearch?: { results?: { entities?: unknown[] } } } };
    const data = await ctx.client.query<Data>(ENTITY_SEARCH_QUERY, { q: entitySearchQuery(input.query.trim()) }, ctx.signal);
    const rows: Row[] = (data?.actor?.entitySearch?.results?.entities ?? []).map(raw => {
      const entity = (raw ?? {}) as Record<string, unknown>;
      return {
        guid: cell(entity.guid),
        name: cell(entity.name),
        type: cell(entity.type),
        domain: cell(entity.domain),
        alert_severity: cell(entity.alertSeverity),
      };
    });
    const columns = ["name", "type", "domain", "alert_severity", "guid"];
    return boundedResult({ rows, cap: MAX_ENTITIES, render: shown => renderLines(shown, columns) });
  },
};

export const alertIssuesTool: NerdGraphTool = {
  name: "alert_issues",
  description:
    "List New Relic alert issues of one account (open by default), highest priority and newest first; up to 25.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["account_id"],
    properties: {
      ...ACCOUNT_PROPERTIES,
      state: { type: "string", enum: Object.keys(STATES), default: "open" },
      priorities: { type: "array", items: { type: "string", enum: PRIORITIES } },
      since: { type: "string", pattern: "^[0-9]+(m|h)$", description: "Only issues opened within this window (≤ 24h)" },
    },
  },
  async run(input, ctx) {
    const id = accountId(input);
    const state = input.state ?? "open";
    const states = typeof state === "string" && state in STATES ? STATES[state]! : undefined;
    if (states === undefined) throw paramsError("state must be open, closed or all");
    const priorities = input.priorities ?? PRIORITIES;
    if (!Array.isArray(priorities) || priorities.length === 0 || priorities.some(p => !PRIORITIES.includes(p))) {
      throw paramsError(`priorities must list values from ${PRIORITIES.join(", ")}`);
    }
    const sinceMs = input.since === undefined ? 0 : ctx.now().getTime() - parseWindow(input.since, "24h") * 60_000;
    const wanted = [...new Set(priorities as string[])].sort();
    // One shared aiIssues query shape (D-4/D-6); all priorities means no priority filter.
    const filter = { states, priorities: wanted.length < PRIORITIES.length ? wanted : null, entityGuids: [] };
    const { issues, more } = await fetchIssuePages(ctx.client, id, filter, ctx.signal, MAX_ISSUE_PAGES);
    const rank = (issue: Record<string, unknown>) => PRIORITIES.indexOf(String(issue.priority));
    const opened = (issue: Record<string, unknown>) => epochMs(issue.activatedAt) ?? epochMs(issue.createdAt) ?? 0;
    const rows: Row[] = issues
      .filter(issue => opened(issue) >= sinceMs)
      .sort((a, b) => rank(a) - rank(b) || opened(b) - opened(a))
      .map(issue => ({
        id: cell(issue.issueId),
        title: cell(Array.isArray(issue.title) ? issue.title.join("; ") : issue.title),
        priority: cell(issue.priority),
        state: cell(issue.state),
        entities: cell(Array.isArray(issue.entityNames) ? issue.entityNames.join(", ") : issue.entityNames),
        opened_at: opened(issue) ? new Date(opened(issue)).toISOString() : null,
        url: ctx.endpoints.web ?? null,
      }));
    const columns = ["priority", "state", "opened_at", "id", "entities", "title"];
    return boundedResult({
      rows,
      cap: MAX_ISSUES,
      more,
      render: shown => renderLines(shown, columns) + (ctx.endpoints.web && shown.length ? `\nurl: ${ctx.endpoints.web}` : ""),
    });
  },
};
