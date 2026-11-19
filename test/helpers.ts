import assert from "node:assert/strict";

import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue, ToolResult } from "@compozy/extension-sdk";

import { SourceError } from "../src/errors.ts";
import { redactor } from "../src/items.ts";
import { createMcpCatalog, OAUTH_ONLY_SEED } from "../src/mcp-catalog.ts";
import { createMcpClient } from "../src/mcp-client.ts";
import type { NerdGraphClient } from "../src/nerdgraph.ts";
import { toolHandler, TOOLS } from "../src/tools/index.ts";
import { startFakeNerdGraph } from "./fake-nerdgraph.ts";

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
    workspace: { id: "ws_test", root_dir: "/nonexistent/compozy-test-ws" },
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

/**
 * MCP proxy harness: the in-process fake NerdGraph + MCP, a counting fetch, an injected clock and
 * stderr, and a fresh catalog with its own OAuth-only set (no state leaks between tests).
 */
export async function startProxyHarness() {
  const nr = await startFakeNerdGraph();
  let fetches = 0;
  let clock = Date.parse(NOW);
  const lines: string[] = [];
  const countingFetch = ((url: string, init: RequestInit) => {
    fetches++;
    return fetch(url, init);
  }) as typeof fetch;
  const stderr = { write: (line: string) => lines.push(line) };
  const oauthOnly = new Set<string>(OAUTH_ONLY_SEED);
  const mcp = createMcpCatalog({
    client: region => createMcpClient(region, FAKE_KEY, { fetch: countingFetch }),
    now: () => clock,
    stderr,
    oauthOnly,
    redact: redactor(FAKE_KEY),
  });
  const deps = { env: { NEW_RELIC_API_KEY: FAKE_KEY }, fetch: countingFetch, now: () => new Date(clock), stderr, mcp };
  return {
    nr,
    mcp,
    oauthOnly,
    deps,
    lines,
    fetches: () => fetches,
    advance: (ms: number) => void (clock += ms),
    async call(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = TOOLS.find(entry => entry.name === name)!;
      return (await toolHandler(tool, deps)({ input: { region: nr.region, ...input } } as never)) as never;
    },
  };
}

/** Structured output of a proxy tool result. */
export function out(result: unknown): Record<string, any> {
  return (result as { structured: Record<string, any> }).structured;
}

/** Tool error codes CompozyOS 0.7.0 keeps from an extension (internal/extension/tool_runtime.go). */
export const ALLOWED_TOOL_CODES = ["tool_invalid_input", "tool_denied", "tool_unavailable", "tool_timed_out", "tool_backend_failed"];

/**
 * Decodes a tool error (Deviation D-18): `data` must be exactly a CompozyOS ToolError
 * `{code: tool_*, message, operator: {cause, recovery}}` whose message (= cause) is
 * `<extension code>[ (<reason>)]: <text>` and whose recovery is non-empty. Returns the
 * extension code, reason and text, plus the tool_* code as `toolCode`.
 */
export function decodeToolError(error: unknown): { toolCode: string; code: string; reason?: string; message: string } {
  const rpc = error as { message: string; data?: Record<string, unknown> };
  const data = rpc.data ?? {};
  assert.deepEqual(Object.keys(data).sort(), ["code", "message", "operator"]);
  assert.ok(ALLOWED_TOOL_CODES.includes(String(data.code)), String(data.code));
  assert.equal(data.message, rpc.message);
  // CompozyOS shows agents only operator.cause and operator.recovery, kept when both are non-empty.
  const operator = data.operator as { cause?: unknown; recovery?: unknown };
  assert.deepEqual(Object.keys(operator).sort(), ["cause", "recovery"]);
  assert.equal(operator.cause, data.message);
  assert.ok(typeof operator.recovery === "string" && operator.recovery.trim().length > 0);
  const match = /^(\w+)(?: \((\w+)\))?: ([\s\S]+)$/.exec(String(data.message));
  assert.ok(match, String(data.message));
  return { toolCode: String(data.code), code: match[1]!, ...(match[2] ? { reason: match[2] } : {}), message: match[3]! };
}

/** Awaits a rejected tool call and returns its decoded `{code, reason?, message}` (no toolCode). */
export async function toolFailure(promise: Promise<unknown>): Promise<{ code: string; reason?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { toolCode: _toolCode, ...decoded } = decodeToolError(error);
    return decoded;
  }
  throw new Error("expected a tool error");
}
