import { paramsError } from "./errors.ts";
import type { Region } from "./nerdgraph.ts";

/** Parameters every kind accepts. `notifyExisting` never enters the fingerprint. */
export interface CommonParams {
  accountId: number;
  region: Region;
  notifyExisting: boolean;
}

export const REGION_PATTERN = "^(us|eu|loopback:[0-9]{1,5})$";
export const WINDOW_PATTERN = "^[0-9]+(m|h)$";

/** JSON Schema properties shared by every kind's params schema (spread into `properties`). */
export const COMMON_PROPERTIES = {
  account_id: { type: "integer", minimum: 1 },
  region: { type: "string", pattern: REGION_PATTERN, default: "us" },
  notify_existing: { type: "boolean", default: false },
} as const;

export function asObject(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function parseCommon(raw: Record<string, unknown>): CommonParams {
  const accountId = raw.account_id;
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId < 1) {
    throw paramsError("set with.account_id to your New Relic account id (a positive integer)");
  }
  const notifyExisting = raw.notify_existing ?? false;
  if (typeof notifyExisting !== "boolean") throw paramsError("notify_existing must be true or false");
  return { accountId, region: parseRegion(raw.region), notifyExisting };
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
