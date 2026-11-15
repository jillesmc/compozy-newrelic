# New Relic official MCP proxy (`newrelic` v0.2.0)

Status: draft for review · 2026-11-15 · Repo `jillesmc/compozy-newrelic` · Builds on
`.compozy/tasks/newrelic-sources/` (v0.1.0, its Business Rules, ADRs and deviations D-1..D-11 stay in
force unless changed here) · CompozyOS ≥ 0.7.0

# Part I — Product

## Overview

- **Motivating Problem**: v0.1.0 gives agents six NerdGraph tools and exposes the official New Relic
  MCP only through OAuth. Today the operator also keeps a hand-made `newrelicapi` MCP (stdio
  `mcp-remote` with an API-key header plus a `trusted_sources` grant) with 37 tools, because:
  - OAuth sessions require a new login every 24 hours (New Relic MCP docs), which breaks unattended
    always-on agents;
  - the 31 tools missing from the extension include traces, dashboards, alert policies and
    conditions, change events, Errors Inbox and New Relic's ready-made analyses.

  The API-key path has its own trap: OAuth-only tools such as `natural_language_to_nrql_query` are
  listed but fail with `403 … requires OAuth authentication` (reproduced 2026-11-14), and a free or
  non-enabled account has no MCP at all.

  Simplest outcome: with only `NEW_RELIC_API_KEY` bound, an agent can list and call every official
  MCP tool that actually works for that key, through the extension. It never sees one that cannot
  work. The operator can then delete the manual `newrelicapi` config.
- **Who**: operators already on v0.1.0, and their always-on agents.
- **Why**: one configuration point (key + region), no lost capability, no 24 h re-login, no token
  waste on dead tools, and new New Relic tools appear without a release.

## Goals

- Agents reach the official MCP's working tools with the API key alone, US or EU.
- OAuth-only tools, tools not marked read-only, and an unavailable MCP never cost the agent more than
  one short, deterministic answer.
- Tools New Relic adds later become callable without a new extension release. Tools New Relic
  removes disappear.
- The check-in sources stay NerdGraph-only and deterministic (v0.1 Business Rule 12 unchanged).
- The manual `newrelicapi` setup becomes unnecessary and the README explains the migration.

## User Stories

- US-101–US-104: proxy catalog and calls.
- US-105: free and unavailable plans.
- US-106: migration from `newrelicapi`.
- US-107–US-108: v0.1.x follow-ups (install scope, nested NRQL cells).

[Full user stories](_user_stories.md)

## Core Features

1. **`ext__newrelic__mcp_tools`**: returns the filtered catalog of the official MCP for a region, as
   compact rows (`name`, one-line description, input schema). It can be narrowed with a `query`
   substring and capped.
2. **`ext__newrelic__mcp_call`**: forwards one `tools/call` (`tool`, `arguments`, `region`) and
   returns a bounded result. Calls to tools outside the filtered catalog are refused locally,
   without a network call.
3. **Filtering** (ADR-001 of this spec). A tool is exposed only when all three hold:
   - its annotations carry `readOnlyHint: true` and do not carry `destructiveHint: true`;
   - it is not on the OAuth-only list (static seed plus runtime learning from a `requires OAuth`
     403);
   - the MCP probe for that region reports `available`.
4. **Availability**. The v0.1 doctor probe is reused and extended to a `tools/list` count. Its result
   is cached per region for the extension process lifetime and refreshed when the catalog TTL
   expires.
5. **Follow-ups**:
   - plain `compozy extension install …` works without `--scope` when that is feasible (US-107);
   - `nrql_query` renders nested aggregate cells as scalars (US-108).

## Business Rules

1. **Exposure filter.** A tool is exposed only when:
   - `annotations.readOnlyHint === true`;
   - `annotations.destructiveHint !== true`;
   - its name is not in the OAuth-only set;
   - the region's MCP is `available`.

   No name-based heuristics. A missing annotation means the tool is not exposed.
2. **OAuth-only set** = seed `{natural_language_to_nrql_query, search_traces}`, plus any tool whose
   call returned HTTP 403 or a JSON-RPC error whose message contains `requires OAuth`. Learned entries
   last for the process lifetime and are logged once to stderr. The tool name is logged; the key never
   is.
3. **Catalog cache.** `tools/list` results are cached per region for 10 minutes and paged until there
   is no `nextCursor`. A failed refresh keeps the previous catalog for at most another 10 minutes,
   then the region becomes `unavailable`.
4. **Unavailable MCP.** When the probe says `unavailable` or `unknown`, both proxy tools answer
   immediately, with no MCP request. The tool error is `mcp_unavailable`, with the reason and the
   hint "use the ext__newrelic__* NerdGraph tools". The `unknown` state is re-probed at most once per
   minute.
5. **Refusals.** `mcp_call` on a tool not in the exposed catalog returns `mcp_tool_not_exposed`
   naming the reason: `oauth_only`, `not_read_only`, or `unknown_tool`. It sends no request.
6. **Result bounds.**
   - **Text:** content parts are concatenated and capped at 16 KiB, with `truncated: true` when cut.
   - **Structured:** `structuredContent` is passed through when it is 16 KiB or less; otherwise it is
     replaced by the truncated text.
   - **Other content:** non-text parts (images, resources) become one-line placeholders.
   - **Catalog:** `mcp_tools` rows are capped at 60, and each input schema is shortened to its
     properties with type and description.
7. **Secrets.** The API key travels only in the `api-key` header to the region's MCP host. It is
   redacted from results, errors and logs with the v0.1 redaction routine.
8. **Arguments.** Arguments are forwarded as given. The extension does not validate them against the
   remote schema; it relays the remote error instead. The `arguments` size is capped at 64 KiB.
9. **Sources unchanged.** No source module may import the MCP client (enforced by the v0.1 UT-123
   static check, extended to the new module).
10. **Timeouts.**
    - **Session handshake:** each request times out at 10 s.
    - **`tools/call`:** times out at 60 s, because New Relic analyses can be slow.
    - **Session expiry:** an expired session (404 or session error) is re-initialized once per call.

## User Experience

1. **Upgrade:** `compozy extension update newrelic --allow-unverified --yes`, which keeps the bound
   key.
2. **Check:** run `compozy extension exec newrelic --cmd doctor`. It now prints
   `MCP: available (35 tools exposed via API key; 2 OAuth-only hidden)`.
3. **Use:** agents call `ext__newrelic__mcp_tools` (optionally with `query: "trace"`), then
   `ext__newrelic__mcp_call`.
4. **Migrate:** remove the `newrelicapi` `[[mcp_servers]]` block and its `trusted_sources` entry,
   keeping `extension:newrelic`. The README shows the exact diff.

## High-Level Technical Constraints

- Official MCP: Streamable HTTP at `https://mcp.newrelic.com/mcp/` (EU `https://mcp.eu.newrelic.com/mcp/`).
  Requests carry the `api-key` header, `Accept: application/json, text/event-stream`, and JSON-RPC
  2.0. Responses may be plain JSON or SSE. The `Mcp-Session-Id` returned by `initialize` must be echoed.
- No new runtime dependency. The extension uses a minimal in-repo MCP client (`initialize`,
  `notifications/initialized`, `tools/list`, `tools/call`).
- Extension tools are static and always model-visible (CompozyOS 0.7.0). The dynamic catalog
  therefore lives behind two static tools.

## Non-Goals

- MCP resources and prompts (tools only).
- Exposing each remote tool as its own native `ext__newrelic__<tool>` (rejected; see ADR).
- OAuth through the proxy: OAuth stays daemon-owned via the declared servers.
- JP region.

## Open Questions

- Whether the New Relic MCP returns SSE or JSON for API-key calls. The client supports both; S1 records
  which one is observed in operator-run E2E.

---

# Part II — Technical

## Executive Summary

A new module, `src/mcp-client.ts`, implements a minimal Streamable HTTP MCP client per region, with a
lazy initialize, session reuse, and SSE or JSON parsing. `src/mcp-catalog.ts` owns the TTL catalog,
the exposure filter, and the OAuth-only set. `src/tools/mcp-proxy.ts` registers the two tools. The
v0.1 `doctor.ts` reuses the client for its probe and adds counts. Sources are untouched.

## MVP Boundary

- **S1** (client, catalog, both tools, doctor counts, fakes) solves the Motivating Problem.
- **S2** adds the README migration and the `newrelicapi` removal guide.
- **S3** covers the v0.1.x follow-ups: install scope (US-107) and NRQL nested cells (US-108).
- **S4** releases v0.2.0.

## Developer Experience

- [DX contract](_dx.md)

## System Architecture

```text
agent ──ext__newrelic__mcp_tools / mcp_call──▶ tools/mcp-proxy.ts ─▶ mcp-catalog.ts (filter, TTL, oauth-only set)
                                                                    └▶ mcp-client.ts ──HTTPS api-key──▶ mcp[.eu].newrelic.com/mcp/
doctor.ts ─────────────────────────────────────────────────────────────┘ (probe + counts)
sources/* ── nerdgraph.ts only (unchanged; static check forbids mcp-client import)
```

## Architectural Boundaries

- `mcp-client.ts` becomes a third network module, next to `nerdgraph.ts` and `doctor.ts`, and takes
  an injected `fetch`.
- `sources/**` and `engine.ts` must not import `mcp-client.ts` or `mcp-catalog.ts`.

## Implementation Design

### Core Interfaces

```ts
// src/mcp-client.ts
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}
export interface McpClient {
  listTools(signal: AbortSignal): Promise<McpToolDef[]>; // pages nextCursor
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
}
export function createMcpClient(
  region: Region,
  apiKey: string,
  opts?: { fetch?: typeof fetch; now?: () => number }
): McpClient;

// src/mcp-catalog.ts
export type Exposure =
  | { exposed: true }
  | { exposed: false; reason: "oauth_only" | "not_read_only" | "unknown_tool" };
export interface McpCatalog {
  state(region: Region): "available" | "unavailable" | "unknown";
  tools(region: Region, query?: string): Promise<McpToolDef[]>; // exposed only
  exposure(region: Region, name: string): Promise<Exposure>;
  learnOAuthOnly(name: string): void;
}
```

### Tool contracts

| Tool | Input | Output |
| --- | --- | --- |
| `ext__newrelic__mcp_tools` | `region?` (`us` default), `query?` (case-insensitive substring over name and description), `limit?` (≤ 60, default 60) | `{region, state, exposed: [{name, description (≤ 200 chars), input: {prop: "type — description (≤ 80 chars)"}}], hidden: {oauth_only: n, not_read_only: n}, truncated}` |
| `ext__newrelic__mcp_call` | `tool` (string), `arguments?` (object, ≤ 64 KiB), `region?` | `{tool, is_error, text (≤ 16 KiB), structured?, truncated}` |

Both are read-only (`risk: read`, `readOnly: true`), because only read-only remote tools can be reached.

## Integration Points

| Service | Purpose | Auth | Errors |
| --- | --- | --- | --- |
| New Relic MCP | catalog and calls | `api-key` header | 401 → tool error `credential_expired`; 403 with `requires OAuth` → learn + `mcp_tool_not_exposed (oauth_only)`; other 403 or 404 at initialize → state `unavailable`; 429 → `rate_limited`; 5xx, network or timeout → `mcp_request_failed`; a JSON-RPC error from the tool is passed through as `is_error: true` with its text |

## Impact Analysis

| Component | Impact | Risk | Action |
| --- | --- | --- | --- |
| `newrelic` extension | 2 new tools; doctor output gains counts; version 0.2.0 | low | release |
| Operator `newrelicapi` manual MCP | becomes redundant | none (operator removes it) | README migration |
| v0.1 sources | unchanged | none | UT-123 extended |
| OAuth servers | unchanged | none | — |

## Extensibility Integration Plan

`tool.provider` gains 2 tools, so the extension has 9 tools including the doctor. There are no new
capabilities, resources or hooks.

## Agent Manageability Plan

Agents use the two tools and operators use the doctor. Status comes from the existing tool and
extension surfaces.

## Config Lifecycle

No config keys.

## Testing Approach

A fake Streamable-HTTP MCP server (in-process `node:http`) covers:
- JSON and SSE responses;
- `Mcp-Session-Id`;
- `nextCursor` paging;
- annotated, unannotated and destructive tools;
- a 403 `requires OAuth` call;
- 401, 404 and 429 responses.

Tests run in bun and Node 22.

## Development Sequencing

1. **S1**: client, catalog and tools, plus the doctor counts.
2. **S2**: README.
3. **S3**: follow-ups.
4. **S4**: release.

S2 and S3 can run in parallel after S1.

## Monitoring and Observability

- One stderr line per learned OAuth-only tool.
- One line per region state change (`mcp=available|unavailable(<status>)|unknown`).
- No arguments or results are logged.

## Technical Considerations

### Key Decisions

- ADR-001 (this spec): dynamic two-tool proxy over a static mirror.
- Annotation-based read-only filter. Verified on 2026-11-15 that CompozyOS indexes all 37
  `newrelicapi` tools as `risk: read` with no `read_only_tools` override in the operator config, which
  means New Relic sends `readOnlyHint: true`. If New Relic stops annotating, tools disappear rather
  than leak writes. This fails closed, which is intended.

### Known Risks

- Large analysis results get truncated at 16 KiB. The agent can narrow time windows.
- The OAuth-only seed may go stale. Runtime learning covers new cases after one failed call per
  process.

## Safety Invariants

1. The proxy never forwards a call to a tool without `readOnlyHint: true`, or with `destructiveHint: true`.
2. The proxy never forwards a call when the region state is not `available`.
3. The API key never appears outside the request header.
4. Sources never touch the MCP client.

## File References

- `../newrelic-sources/_spec.md`: v0.1 contract, BR-12, D-1..D-11.
- `src/doctor.ts`, `src/nerdgraph.ts`, `src/tools/*`, and the v0.1 redaction helper: reuse them.
- `../../../compozy/internal/mcp/tool_descriptor.go:53-55`: how CompozyOS derives read-only from
  annotations (evidence for the filter).
- https://docs.newrelic.com/docs/agentic-ai/mcp/setup/ (OAuth 24 h re-login, API-key tool limits)

## Assumptions and Defaults

- Catalog TTL 10 min. `mcp_tools` limit 60. Result cap 16 KiB. Arguments cap 64 KiB.
- Timeouts: call 60 s, other requests 10 s.
- MCP protocol version `2025-06-18`.
- Extension version 0.2.0. Signed tag `v0.2.0` with the repo-local personal identity.

## Architecture Decision Records

- [ADR-001: Dynamic two-tool MCP proxy with API key](adrs/adr-001.md)

## Deviations

- **D-12 (2026-11-15, S1, recorded before coding): OAuth learning also reads remote tool errors.**
  Business Rule 2 learns from HTTP 403 or a JSON-RPC error containing `requires OAuth`. Whether New
  Relic reports the OAuth refusal that way, or as a `tools/call` result with `isError: true`, is not
  verified (Open Questions). Change: a result with `isError: true` whose text contains
  `requires OAuth` (case-insensitive) is learned the same way and refused as
  `mcp_tool_not_exposed (oauth_only)`. This only hides a tool that cannot work; it never exposes one.
- **D-13 (2026-11-15, S1, recorded before coding): refusal and state order.**
  1. A seeded or learned OAuth-only name is refused (`oauth_only`) before the catalog or region state
     is consulted, so UT-150 makes zero requests even on a cold or unavailable region. Every other
     name needs an `available` region first (`mcp_unavailable` otherwise), then `unknown_tool`, then
     `not_read_only`. A tool that is both OAuth-only and not read-only reports `oauth_only` and counts
     once, as `oauth_only`, in `hidden`.
  2. Region state: initialize 403/404 (or a 403 on `tools/list`) → `unavailable(<status>)`, re-probed
     after one TTL. Any other probe failure (401, 429, 5xx, network, timeout, no tools capability)
     → `unknown`. The call that ran the probe gets the mapped error (`credential_expired`,
     `rate_limited`, `mcp_request_failed`); calls within the next minute get `mcp_unavailable` with
     the same reason and no request. A failed refresh of a stale catalog is retried at most once per
     minute. If it is still failing two TTLs after the last success, the region becomes
     `unavailable`.
  3. The stderr line format is `newrelic: region=<region> mcp=available|unavailable(<status>)|unknown`.
     The learned-tool line is `newrelic: mcp tool <name> requires OAuth; hidden`.
- **D-14 (2026-11-15, S1, recorded before coding): interface details the Core Interfaces leave open.**
  1. `McpCatalog` gains `hidden(region)` (the `mcp_tools` counts) and `client(region)` (the
     session-reusing client the proxy forwards through).
  2. `createMcpClient` options are `{fetch, timeoutMs, callTimeoutMs}`. The client needs no clock;
     the catalog takes the injected clock for TTLs.
  3. The OAuth-only set is process-wide by default, so the doctor counts learned tools too. Tests
     inject their own set.
  4. Result envelopes. `mcp_tools` returns the contract object as `structured` and its JSON as the
     text. `mcp_call` returns the contract object as `structured` and the bounded remote text as the
     text content. A JSON-RPC error from `tools/call` (other than a session error) is relayed as
     `is_error: true` with its redacted message.
  5. A session is expired when a request that carried `Mcp-Session-Id` gets 404, or 400 with
     `session` in the body.
- **D-15 (2026-11-15, S1, recorded before coding): doctor probe.** The doctor reuses the proxy client
  (`initialize`, `notifications/initialized`, `tools/list`) with the Business Rule 10 timeout of
  10 s. The v0.1 timeout was 5 s. The available line is
  `MCP: available (N tools exposed via API key; M OAuth-only hidden) — agents can use ext__newrelic__mcp_tools / mcp_call`.
  Tools hidden as not read-only are not printed. The unavailable and unknown lines keep their v0.1
  text. A 401 at initialize is still printed as `unavailable (401 …)` (v0.1 UT-101), while the proxy
  tools map it to `credential_expired`. The startup probe line format is unchanged.
- **D-16 (2026-11-15, S3, recorded before coding): US-107 outcome — the OAuth servers default to
  global scope, and a plain install is global.** Investigated in the CompozyOS v0.7.0 source (tag
  `v0.7.0`, paths under `internal/`):
  1. The v0.1 failure comes from the install default, not from validation. With no `--scope` and no
     `--workspace`, the CLI sends an empty scope and workspace (`cli/extension.go`
     `resolveExtensionCLIScope`, which resolves a workspace only for `--scope workspace` or
     `--workspace`). For an operator actor (CLI ingress is a trusted human operator,
     `task/actors.go:29-50`), `applyManifestInstallScope` (`daemon/extensions_scope.go:130-153`) reads
     the manifest servers' `default_scope` and only when it is `workspace` re-resolves the target as
     workspace scope, which fails outside a workspace (`daemon/extensions_scope.go:38-42`,
     `workspace scope requires a workspace`; CompozyOS test "Should require workspace context for a
     workspace default", `daemon/extensions_test.go:1782`). An empty or `global` default leaves the
     target global (`extensions_scope.go:137-150`). Mixed defaults require an explicit scope
     (`:143-144`).
  2. `default_scope` accepts only `""`, `global` or `workspace`
     (`extension/manifest_mcp_auth.go:29-33`). It is otherwise display-only
     (`extension/marketplace_inspection.go:95`, `extension/manifest_tools.go:21`); the runtime server
     spec does not read it (`extension/resource_publication_mcp.go:86`).
  3. OAuth sign-in follows the install scope, not `default_scope`: the auth target is derived from
     the published resource's scope (`daemon/mcp_server_resolver.go:205-255`: user resource or
     default profile → `user`; workspace resource → `workspace` + workspace id).
     `compozy mcp auth login` defaults to `--scope user` (`cli/mcp_auth.go:56`) and requires
     `--workspace` with `--scope workspace` (`cli/mcp_auth.go:280-286`). So login per scope still
     works: `--scope user` for a global install, `--scope workspace --workspace <ws>` for a workspace
     one.

  Change: both servers declare `default_scope = "global"` (`src/mcp-servers.ts`, UT-110). The README
  drops the required `--scope global`; `--scope workspace --workspace <ws>` stays as the per-project
  option, and the OAuth login example uses the default `--scope user`. E2E-104 confirms it on a clean
  0.7.0 profile with and without `--scope`.
- **D-17 (2026-11-15, S3, recorded before coding): US-108 depth.** "Depth 3" counts expanded object
  levels below a result column: `a: {b: {c: {d: {e: 1}}}}` becomes `a.b.c.d: {"e":1}`. Arrays and
  empty objects are not expanded; they stay compact JSON cells. Flattening applies only to
  `nrql_query`, before the existing column, cell (300 characters) and 8 KiB bounds.
