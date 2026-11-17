import type { HeartbeatSourceRequest, HeartbeatSourceResult } from "@compozy/extension-sdk";

import { SourceError, sourceError } from "./errors.ts";
import { redactor } from "./items.ts";
import { createNerdGraphClient, regionEndpoints, resolveApiKey } from "./nerdgraph.ts";
import { applyWorkspaceDefaults } from "./params.ts";
import type { SourceDefinition } from "./sources/source.ts";

export const POLL_BUDGET_MS = 25_000;

export interface PollDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stderr?: { write(line: string): unknown };
  requestTimeoutMs?: number;
  budgetMs?: number;
}

/**
 * Wraps a source kind into a daemon poll handler: params, key check (no network), client, a 25 s
 * budget, and one stderr line per failure with code and HTTP status only.
 */
export function createPollHandler(source: SourceDefinition, deps: PollDeps = {}) {
  const env = deps.env ?? {}; // index.ts passes the process environment; nothing else reads it
  const stderr = deps.stderr ?? process.stderr;
  return async (request: HeartbeatSourceRequest): Promise<HeartbeatSourceResult> => {
    try {
      const params = source.parse(applyWorkspaceDefaults(request.params, env));
      const apiKey = resolveApiKey(env);
      const client = createNerdGraphClient(params.region, apiKey, {
        fetch: deps.fetch,
        requestTimeoutMs: deps.requestTimeoutMs,
      });
      const context = { client, endpoints: regionEndpoints(params.region), redact: redactor(apiKey) };
      return await withBudget(deps.budgetMs ?? POLL_BUDGET_MS, signal =>
        source.poll(request, params, { ...context, signal })
      );
    } catch (error) {
      const failure =
        error instanceof SourceError
          ? error
          : sourceError("source_extension_failed", "New Relic source failed unexpectedly");
      stderr.write(
        `newrelic/${source.kind} poll failed: code=${failure.data?.code} status=${failure.httpStatus ?? "-"}\n`
      );
      throw failure;
    }
  };
}

/** Runs `run` under a deadline that aborts its signal and rejects with a source_extension_failed error. */
export async function withBudget<T>(
  budgetMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  what = "poll"
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = sourceError("source_extension_failed", `New Relic request failed: ${what} budget exceeded`);
      controller.abort(error);
      reject(error);
    }, budgetMs);
  });
  try {
    return await Promise.race([run(controller.signal), budget]);
  } finally {
    clearTimeout(timer);
  }
}
