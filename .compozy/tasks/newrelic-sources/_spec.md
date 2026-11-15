# New Relic check-in sources and investigation tools (`newrelic`)

Status: draft for review · 2026-11-14 · Target repo: `github.com/jillesmc/compozy-newrelic` (new) ·
Host product: CompozyOS ≥ 0.7.0 · Sibling of `jillesmc/compozy-jira` (same toolchain and conventions)

# Part I — Product

## Overview

- **Motivating Problem**: CompozyOS always-on agents have no way to be woken by New Relic. The
  curated Sentry and Grafana packages only register hosted MCP servers. They give an agent that is
  already running tools to investigate, but they never trigger a check-in. Operators who watch New
  Relic either poll by hand or let agents spend model turns querying New Relic on every check-in. The
  hosted New Relic MCP is also a trap for API-key users: OAuth-only tools such as
  `natural_language_to_nrql_query` are listed but fail with
  `403 ... requires OAuth authentication and cannot be used with a New Relic API key` (reproduced
  2026-11-14). An agent burns tokens discovering that. Free accounts and accounts without the MCP admin
  toggle cannot use the MCP at all.

  The simplest end-to-end outcome: install one extension, bind one User API key, and declare a metric
  threshold source. The agent is then woken exactly when the metric starts breaching, and it can
  investigate with tools that are guaranteed to work on the installer's plan.
- **Who it is for**: CompozyOS operators and SREs who use New Relic, on free or paid plans.
- **Why it is valuable**: pre-model change detection (a quiet check costs no model turn) across
  metrics, alerts, errors, and logs. Investigation tools never dead-end on plan or authentication
  limits.

## Goals

- An agent is woken when a NRQL value starts breaching a threshold, a New Relic alert issue opens, an
  error type appears or crosses a count, or a log group starts exceeding a count.
- Signals that stay active never re-wake the agent. A recovered signal can wake it again later.
- Turning a source on, or changing its definition, never floods the agent (quiet baseline).
- Every tool an agent can call works with the installer's credentials and plan. The official MCP's
  tools appear only after a successful OAuth sign-in on an account that can use them.
- Operators learn whether the official MCP is usable for their account without spending agent tokens.
- US is the default region, and EU is selectable per source and per tool.

## User Stories

- US-001–US-006: check-in sources (`newrelic/nrql`, `newrelic/issues`, `newrelic/errors`,
  `newrelic/logs`, quiet start, item shape).
- US-007: operating (one secret, region, errors).
- US-008–US-010: investigation (plan-independent tools, OAuth-gated official MCP, operator doctor).
- US-011: distribution.

[Full user stories](_user_stories.md)

## Core Features

1. **Transition engine** (ADR-001). Each poll computes the set of *active signals*: keys whose value
   satisfies the source's condition. It returns the keys that are active now and were not active in
   the committed set. Keys that stop being active are dropped silently.
2. **Four source kinds** on that engine:
   - `newrelic/nrql`: any NRQL; one numeric value per row; `above`/`below` a threshold.
   - `newrelic/issues`: open NerdGraph alert issues filtered by priority, entity, and policy.
   - `newrelic/errors`: `TransactionError` (and optionally `JavaScriptError`) counts in a window,
     faceted by app, class, and a normalized message.
   - `newrelic/logs`: `Log` counts in a window, for a `WHERE` filter and an optional facet.
3. **Investigation tools** (ADR-002): six read-only, compact, NerdGraph-backed tools that work with a
   User API key on any plan.
4. **OAuth-gated official MCP** (ADR-002): two declared servers, `newrelic` (US) and `newrelic-eu`.
   They expose tools only after OAuth sign-in succeeds, so they self-gate by plan and admin toggle.
5. **Doctor**: a probe of NerdGraph and MCP availability. It runs once at extension start (logged) and
   on demand through `compozy extension exec newrelic --cmd doctor`.
6. **Distribution**: TypeScript with `@compozy/extension-sdk` 0.7.0, Node.js ≥ 22, published as a
   GitHub Release on `jillesmc/compozy-newrelic` with signed commits and tags.

Interactions: sources and tools share one NerdGraph client and credential path. The doctor tells the
operator whether feature 4 is worth enabling.

## Business Rules

1. **Active-signal transition.** An item is returned for a key that is active in this poll and absent
   from the committed active set. The next committed set is
   `(committed ∩ currentActive) ∪ returned`. Returning a still-active key again is forbidden.
2. **Activeness per kind**:
   - nrql: value `> threshold` for `above`, `< threshold` for `below`. A null value is inactive.
   - issues: state `ACTIVATED` or `CREATED` and the priority is in `priorities`.
   - errors: count `>= min_count` within `window`.
   - logs: count `> threshold` within `window`.
3. **Keys**:
   - nrql: the facet tuple joined with `/`, or `_` when the query has no facet.
   - issues: the issue id.
   - errors: `app/class/<first 8 hex of sha256(normalized message)>`.
   - logs: the facet value, or `_` when there is no facet.

   Keys are sanitized to the daemon key alphabet `[A-Za-z0-9._:/#@+-]`, capped at 200 bytes. Longer
   keys keep a 180-byte prefix plus `#` and 12 hex of their hash.
4. **Message normalization (errors).** Lowercase is not applied. Runs of digits, hex ids of 8 or more
   characters, UUIDs, and single- or double-quoted strings each collapse to `#`. Whitespace runs
   collapse to one space. The message is truncated to 160 characters.
5. **Baseline.** There is a baseline when there is no committed state, or when the committed
   fingerprint differs from SHA-256 over the canonical JSON of the kind's defining parameters (all
   parameters except `notify_existing`). A baseline commits the current active set and returns nothing,
   or returns the current active set when `notify_existing: true`.
6. **Per-check volume.** At most `limits.max_items` items per check, ordered by severity:
   - issues: CRITICAL > HIGH > MEDIUM > LOW, then oldest first;
   - others: largest breach margin first.

   Unreturned keys stay out of the committed set and come back next check, with `more: true`.
7. **Capacity.** The committed set must fit `limits.max_state_bytes` (default 16,384 bytes). If it
   does not, the poll fails with `source_params_invalid`. It never truncates silently. NRQL results
   over 500 rows also fail with `source_params_invalid`.
8. **Windows.** `window` matches `^[0-9]+(m|h)$`, from 5 minutes to 24 hours. The source builds
   `SINCE <window> ago` itself. For `newrelic/nrql` the user's NRQL is used verbatim, including its
   own `SINCE`.
9. **Read-only.** NerdGraph is only used for queries; the extension sends no mutation.
10. **Data minimization.**
    - Items carry counts, facet values, and normalized or truncated text only. They never carry raw
      log lines or stack traces.
    - `recent_logs` returns at most 50 lines of at most 300 characters.
    - The API key never appears in items, tool results, errors, logs, or state.
11. **Tool honesty.** The extension registers only tools that work with a User API key on a free
    plan. OAuth-only or paid-only capability reaches agents only through the OAuth MCP servers.

## User Experience

- **First use**:
  1. Install.
  2. Bind `NEW_RELIC_API_KEY` and restart the extension.
  3. Run `doctor`.
  4. Add one or more sources on the agent's Heartbeat page, with **Try it now** showing a quiet baseline.
  5. Optionally `compozy mcp auth login newrelic` when the doctor says the MCP is available.
- **Regular use**: quiet checks show "All quiet". A breach or new alert wakes the agent with one item.
  The agent investigates with `ext__newrelic__*` tools, plus the MCP tools when signed in.
- **Discoverability**: the GitHub topic `compozy-extension`, the README (golden path, NRQL gallery,
  plan matrix), and later the curated catalog (category `development`).

## High-Level Technical Constraints

- New Relic NerdGraph (`https://api.newrelic.com/graphql`, EU `https://api.eu.newrelic.com/graphql`),
  `API-Key` header with a User key (`NRAK-`).
- Official MCP: `https://mcp.newrelic.com/mcp/` (US), `https://mcp.eu.newrelic.com/mcp/` (EU), OAuth
  (scopes `observability:read offline_access`).
- Each poll finishes well within the daemon source deadline (default 30 s). Internal budget is 25 s,
  and each request times out at 10 s.
- Marketplace permission tier; no host API grants.
- Extension manifests cannot carry secret headers or filter MCP tools, and SDK tools are always
  model-visible (CompozyOS 0.7.0, `internal/extension/manifest.go:204-216`,
  `internal/extension/build_describe.go:255`). The design does not depend on either.

## Non-Goals (Out of Scope)

- Recovery notifications (signal back to normal): this is a follow-up. The engine already tracks
  recovery by dropping keys.
- Writes to New Relic (acknowledge issues, mute conditions, create dashboards).
- An API-key path to the official MCP, which would expose 403-failing tools (rejected in ADR-002).
- The JP region (`mcp.jp.` exists for the MCP; NerdGraph JP availability is unverified). This is a
  follow-up.
- Traces and spans as a source kind. The MCP covers trace search after OAuth.
- Bundling into CompozyOS.

## Open Questions

- The exact New Relic OAuth client contract for third-party MCP clients: a pre-configured client id,
  or whether dynamic registration is accepted. S4 verifies this against the live docs and the
  CompozyOS OAuth flow. If neither works, S4 ships the servers documented as "unavailable in
  CompozyOS", and the doctor says so.
- How the MCP answers a free or disabled account (403 at login or at `tools/list`). S4 records it.

---

# Part II — Technical

## Executive Summary

The extension is one TypeScript extension, `newrelic`, structured like `compozy-jira`.

- **Sources:** a NerdGraph client resolves the API key and region and runs GraphQL queries. Each of
  the four source kinds turns a poll into a list of `{key, value, …}` rows. A shared transition engine
  diffs active keys against committed state, orders and pages items, and encodes the next state.
- **Tools:** the six investigation tools reuse the same client with bounded formatting.
- **MCP:** the manifest declares two OAuth MCP servers that CompozyOS gates on successful sign-in.
- **Doctor:** probes NerdGraph (`actor { accounts { id } }`) and the MCP endpoint with the API key,
  through an MCP `initialize` request.

## MVP Boundary

The MVP is S1–S6.

- S1 delivers the earliest useful outcome: `newrelic/nrql` end to end. An agent is woken by a metric
  breach, installed locally and verified against a fake NerdGraph.
- S2 adds issues, errors, and logs.
- S3 adds the investigation tools and the doctor.
- S4 declares the OAuth MCP servers and verifies gating.
- S5 adds the README and CI.
- S6 publishes v0.1.0.
- S7 (catalog PR draft) is post-MVP and requires approval.

## Developer Experience

- [Developer experience contract](_dx.md) covers the HEARTBEAT sources and parameters, the secret,
  the tools, the doctor command, the MCP sign-in, items, and errors.
- No `_uiux.md`: the work has no UI of its own.

## System Architecture

```text
daemon ──heartbeat/source_poll──▶ src/index.ts ─▶ sources/{nrql,issues,errors,logs}.ts ─▶ engine.ts
   │                                    │                       │
   │──tools/call ext__newrelic__*──────▶ tools/*.ts ────────────┤
   │                                                           ▼
   │                                       nerdgraph.ts ──HTTPS API-Key──▶ api[.eu].newrelic.com/graphql
   │                                       doctor.ts ──HTTPS api-key──▶ mcp[.eu].newrelic.com/mcp/ (probe only)
   └── manifest resources.mcp_servers.{newrelic,newrelic-eu} (OAuth, daemon-owned) ──▶ official MCP
```

| Component | Responsibility |
| --- | --- |
| `src/index.ts` | Extension definition, source/tool registration, startup probe, env reading (only module) |
| `src/nerdgraph.ts` | GraphQL POST, region endpoints, timeouts, HTTP/GraphQL error → code mapping (only network module besides doctor) |
| `src/engine.ts` | Active-set diff, baseline/fingerprint, ordering, paging, capacity, state encode/decode (pure) |
| `src/sources/*.ts` | Per-kind params validation, NRQL/GraphQL construction, row → signal mapping, item shaping (pure apart from injected client) |
| `src/normalize.ts` | Error message normalization, key sanitization (pure) |
| `src/tools/*.ts` | Six tools plus doctor, bounded formatting |
| `src/doctor.ts` | NerdGraph and MCP probe with injected fetch |

## Architectural Boundaries

- Only `src/index.ts` imports the SDK `Extension` and reads environment variables.
- Only `src/nerdgraph.ts` and `src/doctor.ts` perform network I/O, through an injected `fetch`.
- `engine.ts` and `normalize.ts` are pure, with no imports outside the repository and Node built-ins.
- The only runtime dependency is `@compozy/extension-sdk` 0.7.0.

## Implementation Design

### Core Interfaces

```ts
// src/engine.ts
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
export function transition(input: {
  committed: unknown; // request.state
  fingerprint: string;
  signals: Signal[]; // currently active only
  notifyExisting: boolean;
  limits: { max_items: number; max_state_bytes: number };
}): HeartbeatSourceResult; // throws source_params_invalid on capacity

// src/nerdgraph.ts
export type Region = "us" | "eu";
export interface NerdGraphClient {
  query<T>(gql: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T>;
  nrql(accountId: number, nrql: string, signal: AbortSignal): Promise<Record<string, unknown>[]>;
}
export function createNerdGraphClient(
  region: Region,
  apiKey: string,
  options?: { fetch?: typeof fetch; requestTimeoutMs?: number }
): NerdGraphClient;
```

### Queries

- NRQL: `query($id:Int!,$q:Nrql!){actor{account(id:$id){nrql(query:$q,timeout:20){results}}}}`.
  For the `nrql` kind, the numeric value is the first numeric field of each row that is not a facet
  (`facet` holds the facet value or an array of values).
- errors:
  `SELECT count(*) FROM <event_types> WHERE <where> FACET appName, error.class, error.message SINCE <window> ago LIMIT 500`.
  Rows are re-grouped after message normalization, summing counts.
- logs: `SELECT count(*) FROM Log WHERE <where> [FACET <facet>] SINCE <window> ago LIMIT 500`.
- issues: `actor { account(id) { aiIssues { issues(filter: { states: [ACTIVATED, CREATED], priority…, entityGuids…, policyIds… }) { issues { issueId title priority state entityNames entityGuids conditionName policyName activatedAt createdAt } nextCursor } } } }`.
  The exact field and filter names are **verified in S2 against live NerdGraph introspection** and
  recorded as a deviation if they differ.
- Doctor:
  - NerdGraph probe: `{ actor { accounts { id } } }`.
  - MCP probe: `POST <mcp-url>` with `api-key: <key>`, MCP `initialize` JSON-RPC (protocol
    `2025-06-18`), and a 5 s timeout.
  - The MCP probe gives `available` on 200 with a server `capabilities.tools` entry;
    `unavailable: <status>` on 401/403/404; `unknown: <error>` otherwise. API-key `initialize` success
    is evidence that the MCP is enabled for the account. Tools are still exposed only through OAuth.

### Data Models

- State: `ActiveStateV1` (above). An unknown or invalid `v` decodes as a baseline. Encoded size is
  checked against `max_state_bytes`.
- Params schemas: one JSON Schema per kind, matching `_dx.md`. `additionalProperties: false`;
  `account_id` is an integer ≥ 1; `region` is an enum; durations and numbers are typed. The daemon
  validates them before calling the extension.
- Manifest additions (via SDK definition):
  - `requires_env = ["NEW_RELIC_API_KEY"]`;
  - `resources.mcp_servers.newrelic = { transport = "http", url = "https://mcp.newrelic.com/mcp/", default_scope = "workspace", auth = { method = "oauth", … } }`;
  - the same for `newrelic-eu`.

  The exact `auth` fields (`client_id`, `issuer_url`, `scopes`, or `registration = "dynamic"`) are
  settled in S4.

## Integration Points

| Service | Purpose | Auth | Errors |
| --- | --- | --- | --- |
| NerdGraph | Sources, tools, doctor | `API-Key: NRAK-…` | 401/403 → `source_credential_expired`; 429 → `source_rate_limited`; HTTP 200 with `errors[]` → `source_params_invalid` (message ≤ 300); 5xx, network, or timeout → `source_extension_failed`. No in-extension retries. |
| New Relic MCP | Probe only (doctor); tools are reached via daemon-owned OAuth | `api-key` for probe; OAuth for use | Probe outcomes as above; never fails a source poll |

## Impact Analysis

| Component | Impact | Description and risk | Action |
| --- | --- | --- | --- |
| `jillesmc/compozy-newrelic` | new | New public repo. Low risk. | S6 |
| `newrelic` extension surfaces | new, experimental 0.x | Four kinds, seven tools, two MCP servers, one secret. | README marks experimental; same 0.x compatibility policy as `compozy-jira` (state `v` bump makes a quiet re-baseline; parameter renames keep the old key for one minor release) |
| Operator's manual `newrelicapi` MCP | unaffected | It can stay or be removed by the operator. The README explains how to replace it with the OAuth server. | Docs only |
| CompozyOS core | unaffected | | — |

## Extensibility Integration Plan

- **Provides:** `heartbeat.source` (4 kinds) and `tool.provider` (7 tools, one with a command block
  `doctor`). Resources: 2 MCP servers.
- **Unaffected (checked):** hooks, skills, profiles, palette views, Loops, forge.

## Agent Manageability Plan

- Sources are operated through the existing heartbeat and instance CLI and native tools.
- Tools are agent-callable.
- The doctor is available as `compozy extension exec newrelic --cmd doctor` and
  `ext__newrelic__doctor`. It is model-visible (SDK limitation), and its description tells agents not
  to call it.
- MCP login uses `compozy mcp auth login`; status uses `compozy__mcp_status` and
  `compozy__mcp_auth_status`.

## Config Lifecycle

No CompozyOS config keys added. The existing `[agents.heartbeat.sources]` `max_items`,
`max_state_bytes`, and `timeout` apply.

## Testing Approach

- `bun test`, with a fake NerdGraph (in-process `node:http`, recorded GraphQL response shapes) and a
  fake MCP endpoint for the doctor. The clock is injected. CI also runs the test suite under Node 22
  (lesson from compozy-jira review C-5).
- Unit tests cover engine, normalize, params, item shaping, and tool formatting. Integration tests
  cover the client and sources against the fakes. E2E covers the local install and a dry-run journey
  against the fakes through the loopback-region test hook. Real-account E2E is operator-run, on
  an account chosen by the operator.

## Development Sequencing

### Build Order

1. Engine, normalize, NerdGraph client, `newrelic/nrql`, and entry point. **S1** ships here: the
   earliest wake-on-breach outcome.
2. Issues, errors, and logs kinds. **S2**, depends on S1.
3. Tools and doctor. **S3**, depends on S1, parallel with S2.
4. OAuth MCP declaration and gating verification. **S4**, depends on S1, parallel.
5. README and CI. **S5**, after S2–S4.
6. Release. **S6**.
7. Catalog PR draft. **S7**, not authorized to open.

### Technical Dependencies

- Node ≥ 22, Bun, and CompozyOS 0.7.0+.
- A New Relic User API key, needed only for the operator-run journeys.
- `gh` keyring auth as `jillesmc`, and the personal GPG key `2642779F0D7BF665` for signed commits and
  tags. This is already set as the repo-local identity.

## Monitoring and Observability

- The daemon's source status, poll duration, and counts.
- One stderr line per failed poll (code and HTTP status), and one startup probe line. No queries,
  results, or keys are logged.

## Technical Considerations

### Key Decisions

- Transition semantics on active sets: ADR-001.
- Investigation layer split (NerdGraph tools plus OAuth-only MCP): ADR-002.
- TypeScript on Node with the SDK pinned to 0.7.0. This reuses the compozy-jira ADR-002 rationale;
  no new ADR.
- A test loopback-region hook replaces env overrides, following compozy-jira D-1. The daemon passes
  extensions only allowlisted env plus declared secrets. A `region` value `loopback:<port>` is
  accepted only when the `NEW_RELIC_TEST_LOOPBACK=1` build flag is compiled in. S1 decides between
  this and a test-only build. It is never documented.

### Known Risks

- NerdGraph `aiIssues` schema drift: S2 introspects and adjusts.
- The OAuth client contract for the MCP: S4 may conclude it is unusable in CompozyOS today. In that
  case, document it and keep the tools.
- Errors Inbox semantics differ from raw `TransactionError` counts. This source counts events, not
  inbox groups (documented).
- NRQL cost: each poll runs one to three NRQL queries. The README advises `min_interval` of 5 minutes
  or more.

## Safety Invariants

1. The extension keeps no state between polls; continuity lives in the returned state.
2. A still-active committed key is never returned again.
3. A failed poll returns an error, with no partial items or state.
4. Dry and real polls with the same inputs return identical results.
5. No NerdGraph mutation is ever sent; no MCP tool is ever called by the extension (probe uses
   `initialize` only).
6. The API key never leaves the request header.

## File References

### Repo Files (CompozyOS checkout at `../compozy`, compozy-jira at `../compozy-jira`)

- `../compozy-jira/src/`: the delivered sibling. Reuse its structure: the poll and engine split,
  redaction, the error mapping, the loopback test approach (D-1), and the 2 KiB attributes bound
  (review R-1).
- `../compozy-jira/.compozy/tasks/jira-issues-source/_spec.md`: deviations D-1 to D-7 and review
  findings R-1 to R-9. Avoid repeating them.
- `../compozy/sdk/typescript/src/heartbeat-source.ts`, `extension.ts:210-230`: source registration.
- `../compozy/packages/site/content/docs/extensions/commands.mdx`: the `command` block for `doctor`.
- `../compozy/internal/extension/manifest.go:204-226`: the MCP server and OAuth fields available to
  manifests.
- `../compozy/internal/extension/build_describe.go:255`: why SDK tools are always model-visible.
- `../compozy/internal/extension/heartbeat_source.go:112-177`: daemon params validation and error codes.
- `../compozy/catalog/packages/sentry/extension.toml`: the OAuth hosted-MCP pattern this mirrors for
  feature 4.
- `../compozy/packages/site/content/docs/agents/heartbeat.mdx:401-409`: item and state limits.

### External References

- New Relic MCP setup and overview (OAuth, API key limits, plan requirement):
  https://docs.newrelic.com/docs/agentic-ai/mcp/setup/ and
  https://docs.newrelic.com/docs/agentic-ai/mcp/overview/
- NerdGraph NRQL and aiIssues: cited by concept and verified by introspection in S1 and S2.

## Assumptions and Defaults

- Region `us`. Request timeout 10 s, poll budget 25 s, MCP probe 5 s.
- NRQL row cap 500. Tool rows ≤ 50 (25 for entities, issues, and error groups), tool text ≤ 8 KiB.
- `newrelic/errors`: `window` 30m, `min_count` 1, `event_types` `[TransactionError]`.
- `newrelic/logs`: `window` 15m.
- `newrelic/issues`: `priorities` `[CRITICAL, HIGH]`.
- `newrelic/nrql`: `condition` `above`.
- License MIT. Repo `jillesmc/compozy-newrelic`, GitHub topic `compozy-extension`, first tag `v0.1.0`,
  signed with the personal key.

## Architecture Decision Records

- [ADR-001: Transition semantics on active-signal sets](adrs/adr-001.md)
- [ADR-002: Investigation layer — NerdGraph tools plus OAuth-only official MCP](adrs/adr-002.md)
