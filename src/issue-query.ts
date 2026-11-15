import { sourceError } from "./errors.ts";
import { accountError, type NerdGraphClient } from "./nerdgraph.ts";

/**
 * The single `aiIssues` query shape shared by `newrelic/issues` and `alert_issues` (Deviations D-4,
 * D-6). Filter and cursor are GraphQL literals because the public docs do not name the input types;
 * strings are JSON-encoded (a subset of GraphQL escaping) and only `$id` is a variable.
 */
export interface IssueFilter {
  /** Issue states; `null` sends no state filter. */
  states: readonly string[] | null;
  /** Priorities; `null` sends no priority filter. */
  priorities: readonly string[] | null;
  entityGuids: readonly string[];
}

const list = (values: readonly string[]) => `[${values.map(value => JSON.stringify(value)).join(",")}]`;

export function issuesQuery(filter: IssueFilter, cursor: string | null): string {
  const parts = [
    ...(filter.states ? [`states:[${filter.states.join(",")}]`] : []),
    ...(filter.priorities ? [`priority:${list(filter.priorities)}`] : []),
    ...(filter.entityGuids.length ? [`entityGuids:${list(filter.entityGuids)}`] : []),
  ];
  const args = [
    ...(parts.length ? [`filter:{${parts.join(",")}}`] : []),
    ...(cursor ? [`cursor:${JSON.stringify(cursor)}`] : []),
  ].join(",");
  return (
    "query($id:Int!){actor{account(id:$id){aiIssues{" +
    `issues${args ? `(${args})` : ""}{issues{issueId title priority state entityNames activatedAt createdAt} nextCursor}` +
    "}}}}"
  );
}

type IssuesData = {
  actor?: {
    account?: { aiIssues?: { issues?: { issues?: unknown; nextCursor?: unknown } | null } | null } | null;
  };
};

/**
 * Up to `maxPages` pages of issues, following `nextCursor` until it is empty or null; `more` is true
 * when a further page exists. A missing account maps to the account-access error.
 */
export async function fetchIssuePages(
  client: NerdGraphClient,
  accountId: number,
  filter: IssueFilter,
  signal: AbortSignal,
  maxPages: number
): Promise<{ issues: Record<string, unknown>[]; more: boolean }> {
  const issues: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: IssuesData = await client.query<IssuesData>(issuesQuery(filter, cursor), { id: accountId }, signal);
    const account = data?.actor?.account;
    if (!account) throw accountError(accountId);
    const result = account.aiIssues?.issues;
    if (!result || !Array.isArray(result.issues)) {
      throw sourceError("source_extension_failed", "New Relic request failed: unexpected response");
    }
    issues.push(...result.issues.filter((row): row is Record<string, unknown> => !!row && typeof row === "object"));
    cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : null;
    if (cursor === null) return { issues, more: false };
  }
  return { issues, more: true };
}

/** EpochMilliseconds, which NerdGraph may serialize as a number or a numeric string. */
export function epochMs(raw: unknown): number | null {
  const ms = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(ms) && ms < 1e13 ? ms : null; // < year 2286 keeps toISOString and ranks safe
}
