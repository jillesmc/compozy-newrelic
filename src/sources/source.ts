import type { HeartbeatSourceRequest, HeartbeatSourceResult, JSONValue } from "@compozy/extension-sdk";

import type { NerdGraphClient, RegionEndpoints } from "../nerdgraph.ts";
import type { CommonParams } from "../params.ts";

/** Resolved params of any kind: the common fields plus the Business Rule 5 fingerprint. */
export interface ParsedParams extends CommonParams {
  fingerprint: string;
}

export interface SourceContext {
  client: NerdGraphClient;
  endpoints: RegionEndpoints;
  /** Bound-key redaction; apply to every NerdGraph-sourced or user-written string before clipping. */
  redact: (text: string) => string;
  signal: AbortSignal;
}

/**
 * One check-in source kind. `parse` validates params without I/O; `poll` is a deterministic function
 * of (params, request.state, request.now, NerdGraph responses) (Business Rule 12).
 */
export interface SourceDefinition<P extends ParsedParams = ParsedParams> {
  kind: string; // registered as newrelic/<kind>
  title: string;
  description: string;
  params_schema: JSONValue;
  parse(raw: unknown): P;
  poll(request: HeartbeatSourceRequest, params: P, context: SourceContext): Promise<HeartbeatSourceResult>;
}
