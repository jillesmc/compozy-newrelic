import assert from "node:assert/strict";

import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import { SourceError } from "../src/errors.ts";
import type { NerdGraphClient } from "../src/nerdgraph.ts";

export const ACCOUNT = 1234567;
export const FAKE_KEY = "NRAK-FAKE0TEST0KEY0000000000000";
export const NOW = "2026-11-14T12:00:00Z";

export function pollRequest(
  params: Record<string, unknown>,
  state: unknown = null,
  overrides: Partial<HeartbeatSourceRequest> = {}
): HeartbeatSourceRequest {
  return {
    version: 1,
    source_id: "checkout-p95",
    kind: "nrql",
    params: params as JSONValue,
    state: state as JSONValue,
    limits: { max_items: 20, max_summary_bytes: 1024, max_state_bytes: 16384 },
    workspace: { id: "ws_test", root_dir: "/tmp/ws" },
    now: NOW,
    dry_run: false,
    ...overrides,
  };
}

/** Fake NerdGraph client for unit tests: every NRQL query answers `rows()`. */
export function fakeClient(rows: () => Record<string, unknown>[]): NerdGraphClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query() {
      throw new Error("query not expected");
    },
    async nrql(_accountId, nrql) {
      calls.push(nrql);
      return structuredClone(rows());
    },
  };
}

export async function rejection(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

export function catchSync(fn: () => unknown): SourceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw error;
  }
  throw new Error("expected a throw");
}

export const identity = (text: string): string => text;

/** Deterministic permutations of `rows`: reversed, rotated, and a seeded shuffle. */
export function permutations<T>(rows: T[]): T[][] {
  let seed = 42;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return [[...rows].reverse(), [...rows.slice(1), ...rows.slice(0, 1)], shuffled];
}

/**
 * UT-121 helper, reusable for every kind: `run(rows)` must give a byte-identical result for every
 * ordering of the NerdGraph rows.
 */
export async function assertRowOrderInvariant(
  rows: Record<string, unknown>[],
  run: (rows: Record<string, unknown>[]) => Promise<HeartbeatSourceResult>
): Promise<HeartbeatSourceResult> {
  const expected = await run(structuredClone(rows));
  for (const order of permutations(rows)) {
    const actual = await run(structuredClone(order));
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  }
  return expected;
}
