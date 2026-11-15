import type { HeartbeatSourceItem, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { paramsError } from "./errors.ts";
import { sha256Hex } from "./normalize.ts";

export interface Signal {
  key: string; // sanitized, ≤ 200 bytes
  rank: number; // ordering: higher first
  item: HeartbeatSourceItem; // fully shaped, within daemon limits
}

export interface ActiveStateV1 {
  v: 1;
  fp: string; // 16 hex of sha256(canonical defining params)
  active: string[]; // sorted unique keys
}

export interface TransitionLimits {
  max_items: number;
  max_state_bytes: number;
}

/** JSON with object keys sorted recursively, so equal values always encode to equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Business Rule 5: 16 hex of SHA-256 over the canonical JSON of the defining parameters. */
export function fingerprint(definingParams: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(definingParams)).slice(0, 16);
}

/** Parses committed state; anything unknown or malformed is null, which means a quiet baseline. */
export function decodeState(raw: unknown): ActiveStateV1 | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { v, fp, active } = raw as Record<string, unknown>;
  if (v !== 1 || typeof fp !== "string" || !/^[0-9a-f]{16}$/.test(fp)) return null;
  if (!Array.isArray(active) || !active.every(key => typeof key === "string")) return null;
  return { v: 1, fp, active: active as string[] };
}

/** Canonical state: fixed field order, keys sorted (code-unit order) and de-duplicated. */
export function encodeState(fp: string, keys: Iterable<string>): ActiveStateV1 {
  return { v: 1, fp, active: [...new Set(keys)].sort(compareKeys) };
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function capacityMessage(count: number, maxStateBytes: number): string {
  return `${count} active signals do not fit max_state_bytes=${maxStateBytes}; narrow the source`;
}

/**
 * ADR-001 transition (Business Rules 1, 5–7): returns the active keys absent from the committed set,
 * highest rank first (ties by key ascending), at most `max_items`; the next committed set is
 * `(committed ∩ active) ∪ returned`. The whole active set must fit `max_state_bytes`.
 */
export function transition(input: {
  committed: unknown;
  fingerprint: string;
  signals: Signal[];
  notifyExisting: boolean;
  limits: TransitionLimits;
}): HeartbeatSourceResult {
  const { fingerprint: fp, limits } = input;
  const ordered = [...input.signals].sort((a, b) => b.rank - a.rank || compareKeys(a.key, b.key));
  const signals: Signal[] = [];
  const active = new Set<string>();
  for (const signal of ordered) {
    if (active.has(signal.key)) continue;
    active.add(signal.key);
    signals.push(signal);
  }
  // Exact capacity over the whole active set, not just the next state (compozy-jira D-3).
  const full = encodeState(fp, active);
  if (Buffer.byteLength(JSON.stringify(full), "utf8") > limits.max_state_bytes) {
    throw paramsError(capacityMessage(active.size, limits.max_state_bytes));
  }

  const committed = decodeState(input.committed);
  const baseline = committed === null || committed.fp !== fp;
  if (baseline && !input.notifyExisting) {
    return { items: [], state: full as unknown as JSONValue, more: false };
  }
  const known = new Set(baseline ? [] : committed.active);
  const fresh = signals.filter(signal => !known.has(signal.key));
  const returned = fresh.slice(0, Math.max(0, limits.max_items));
  const kept = [...known].filter(key => active.has(key));
  const state = encodeState(fp, [...kept, ...returned.map(signal => signal.key)]);
  return {
    items: returned.map(signal => signal.item),
    state: state as unknown as JSONValue,
    more: fresh.length > returned.length,
  };
}
