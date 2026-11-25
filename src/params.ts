import { paramsError } from "./errors.ts";
import type { Region } from "./nerdgraph.ts";

export const MAX_ACCOUNTS = 20;

/** Parameters every kind accepts. `notifyExisting` never enters the fingerprint. */
export interface CommonParams {
  /** The first (lowest) of `accountIds`; the only one unless the source is cross-account. */
  accountId: number;
  /** Sorted, unique, at least one; two or more query cross-account (D-24). */
  accountIds: number[];
  region: Region;
  notifyExisting: boolean;
}

export const REGION_PATTERN = "^(us|eu|loopback:[0-9]{1,5})$";
export const WINDOW_PATTERN = "^[0-9]+(m|h)$";

/** JSON Schema properties shared by every kind's params schema (spread into `properties`). */
export const COMMON_PROPERTIES = {
  account_id: { type: "integer", minimum: 1 },
  /** Cross-account (D-24); defaults to `accounts` in `.compozy/newrelic.toml`. `account_id` wins. */
  account_ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: MAX_ACCOUNTS },
  /** Fills `{{app}}` in `with.where`; defaults to `app` in `.compozy/newrelic.toml` (project-config.ts). */
  app: { type: "string", minLength: 1, maxLength: 256 },
  region: { type: "string", pattern: REGION_PATTERN, default: "us" },
  notify_existing: { type: "boolean", default: false },
} as const;

export function asObject(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function parseCommon(raw: Record<string, unknown>): CommonParams {
  const accountIds = accountIdsOf(raw, "set with.account_id to your New Relic account id (a positive integer)", "with.");
  if (!accountIds) throw paramsError("set with.account_id, account_id in .compozy/newrelic.toml, or NEW_RELIC_ACCOUNT_ID");
  const notifyExisting = raw.notify_existing ?? false;
  if (typeof notifyExisting !== "boolean") throw paramsError("notify_existing must be true or false");
  return { accountId: accountIds[0]!, accountIds, region: parseRegion(raw.region), notifyExisting };
}

const isAccountId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id >= 1;

/**
 * `account_id` (wins) or `account_ids` as sorted unique ids; undefined when neither is set. `invalid`
 * is the message for a bad `account_id`; `prefix` names the parameters (`with.` for sources).
 */
export function accountIdsOf(raw: Record<string, unknown>, invalid: string, prefix: string): number[] | undefined {
  if (raw.account_id !== undefined) {
    if (!isAccountId(raw.account_id)) throw paramsError(invalid);
    return [raw.account_id];
  }
  const ids = raw.account_ids;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ACCOUNTS || !ids.every(isAccountId)) {
    throw paramsError(`${prefix}account_ids must be a list of 1 to ${MAX_ACCOUNTS} account ids (positive integers)`);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Fingerprint fields for the accounts: `account_id` for one (unchanged since 0.1), else `account_ids`. */
export function accountFingerprint(params: CommonParams): Record<string, unknown> {
  return params.accountIds.length > 1 ? { account_ids: params.accountIds } : { account_id: params.accountId };
}

/** `account 1234567`, or `accounts 1234567, 7654321` cross-account, for item text. */
export function accountsText(params: Pick<CommonParams, "accountIds">): string {
  return `${params.accountIds.length > 1 ? "accounts" : "account"} ${params.accountIds.join(", ")}`;
}

export function parseRegion(raw: unknown): Region {
  if (raw === undefined || raw === null || raw === "us") return "us";
  if (raw === "eu") return "eu";
  const loopback = typeof raw === "string" ? /^loopback:([0-9]{1,5})$/.exec(raw) : null;
  const port = loopback ? Number(loopback[1]) : 0;
  if (port >= 1 && port <= 65535) return `loopback:${port}`;
  throw paramsError("region must be us or eu");
}

/** Business Rule 8: `<n>m` or `<n>h`, from 5 minutes to 24 hours; returns minutes. */
export function parseWindow(raw: unknown, fallback: string): number {
  const value = raw ?? fallback;
  const match = typeof value === "string" ? /^([0-9]+)(m|h)$/.exec(value) : null;
  const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : 0;
  if (minutes < 5 || minutes > 24 * 60) throw paramsError("window must be a duration from 5m to 24h, like 30m");
  return minutes;
}

/** NRQL `SINCE` clause for a window in minutes. */
export function sinceClause(minutes: number): string {
  return `SINCE ${minutes} minutes ago`;
}

export function requiredString(raw: unknown, name: string, maxLength = 4000): string {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > maxLength) {
    throw paramsError(`set with.${name} (a non-empty string of at most ${maxLength} characters)`);
  }
  return raw.trim();
}

export function requiredNumber(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw paramsError(`set with.${name} to a number`);
  return raw;
}

/** Integer ≥ `min`; `fallback` applies when the param is absent (required when it is undefined). */
export function integerParam(raw: unknown, name: string, min: number, fallback?: number): number {
  const value = raw ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw paramsError(`set with.${name} to an integer of at least ${min}`);
  }
  return value;
}

/**
 * Non-empty list of strings, each in `allowed` (when given) or matching `pattern`; returned sorted and
 * de-duplicated so equivalent spellings share a fingerprint. Absent → `fallback`.
 */
export function stringListParam(
  raw: unknown,
  name: string,
  check: { allowed?: readonly string[]; pattern?: RegExp; fallback: string[]; minItems?: number; maxItems?: number }
): string[] {
  const value = raw ?? check.fallback;
  const valid =
    Array.isArray(value) &&
    value.length >= (check.minItems ?? 0) &&
    value.length <= (check.maxItems ?? 100) &&
    value.every(
      entry =>
        typeof entry === "string" &&
        (check.allowed ? check.allowed.includes(entry) : (check.pattern?.test(entry) ?? entry !== ""))
    );
  if (!valid) {
    const hint = check.allowed ? `any of ${check.allowed.join(", ")}` : "valid strings";
    throw paramsError(`with.${name} must be a list of ${hint}`);
  }
  return [...new Set(value as string[])].sort();
}
