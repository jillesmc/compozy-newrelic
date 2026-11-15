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
12. **Deterministic, model-free sources** (operator addition, 2026-11-15). The four check-in sources
    are the operator's zero-token gate for always-on agents, so each poll is a deterministic function
    of (params, committed state, `request.now`, NerdGraph responses):
    1. Sources never call an LLM, any New Relic AI feature (for example natural-language-to-NRQL), or
       any MCP server or tool; they only send fixed NRQL/GraphQL built from params. The investigation
       tools are separate and are used only by the agent after it is woken.
    2. Identical inputs produce byte-identical results: stable ordering with rank ties broken by key
       ascending; NerdGraph row order does not affect output (sort before processing); fixed number
       formatting and UTC ISO timestamps in titles, summaries, and attributes; no wall-clock reads (use
       `request.now`), no randomness, no locale-dependent formatting.
    3. Volatile values never create items by themselves: only key transitions (inactive → active) emit
       items; a poll with nothing new returns an empty item list so the daemon skips the model.
    4. State is canonical: `active` keys sorted and de-duplicated, stable JSON key order; when the
       active set is unchanged the encoded state is byte-identical to the committed one.

## User Experience

- **First use**:
  1. Install.
  2. Bind `NEW_RELIC_API_KEY` and restart the extension.
  3. Grant the tool source: `[tools.policy] trusted_sources = ["extension:newrelic"]`, then restart
     the daemon (Deviation D-10).
  4. Run `doctor`.
  5. Add one or more sources on the agent's Heartbeat page, with **Try it now** showing a quiet baseline.
  6. Optionally `compozy mcp auth login newrelic` when the doctor says the MCP is available.
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
  CompozyOS", and the doctor says so. **Resolved by D-S4-a**: pre-registered public client; the
  authorize step is verified, and token exchange is left to E2E-004.
- How the MCP answers a free or disabled account (403 at login or at `tools/list`). S4 records it.
  **Still open (D-S4-a, unverified assumptions)**: needs an operator-run E2E-004 on such an account.

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

## Deviations

- **D-1 (2026-11-14, conductor, recorded before S1 coding): the loopback region is always compiled in
  and undocumented.** CompozyOS 0.7.0 passes extensions only allowlisted env plus declared secrets
  (compozy-jira D-1), so a `NEW_RELIC_TEST_LOOPBACK=1` runtime flag never reaches the extension, and a
  test-only build would make E2E-005 (published artifact against the fakes) impossible. Change: every
  `region` parameter (sources, tools, `doctor --region`) accepts `us`, `eu`, or `loopback:<port>`
  (port 1–65535). A loopback region sends NerdGraph requests to `http://127.0.0.1:<port>/graphql`
  and the MCP probe to `http://127.0.0.1:<port>/mcp/`; it is never used by default, never appears in
  the README golden path or examples, and is mentioned only as a local testing aid. No other host is
  accepted. The API key still travels only in the request header.
- **D-2 (2026-11-15, S1, recorded before coding): item keys follow the daemon key pattern exactly.**
  CompozyOS 0.7.0 validates item keys with `^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,199}$`
  (`internal/heartbeat/source/source.go:85`): the first character must be alphanumeric, so the
  Business Rule 3 no-facet key `_` (and any raw facet value starting with `_`, `-`, `.` and so on)
  would make the daemon reject the whole result. Change: (a) the no-facet key for `newrelic/nrql` and
  `newrelic/logs` is `all` instead of `_`; (b) sanitization replaces every character outside
  `[A-Za-z0-9._:/#@+-]` with `-` and prefixes `x` when the first character is not alphanumeric; when
  this changes the raw key, `#` plus 8 hex of SHA-256 of the raw key is appended so distinct raw
  values never collide; (c) a key still over 200 bytes keeps a 180-byte prefix plus `#` and 12 hex of
  SHA-256 of the raw key (unchanged rule). Keys that are already valid are kept verbatim.
- **D-3 (2026-11-15, S1, recorded before coding): `Region` type includes the D-1 loopback form.**
  `src/nerdgraph.ts` declares `type Region = "us" | "eu" | \`loopback:${number}\`` (the Core Interfaces
  block shows only `"us" | "eu"`), and the `region` params schema is the string pattern
  `^(us|eu|loopback:[0-9]{1,5})$` instead of an enum, because the daemon validates params against the
  schema before the extension sees them. The port range 1–65535 is checked in code.
- **D-4 (alias D-S2-a; 2026-11-15, S2, recorded before coding): `newrelic/issues` follows the publicly documented
  `aiIssues` schema, not the Queries guess.** Source: `_research-public-docs.md` (New Relic docs
  "NerdGraph issues API"). `FilterIssues` has only `entityGuids`, `entityTypes`, `ids`, `priority`
  (`[String!]`) and `states`; `Issue` has no `conditionName` or `policyName`, and `title` is
  `[String!]!`. Changes:
  1. Query: `query($id:Int!){actor{account(id:$id){aiIssues{issues(filter:{states:[ACTIVATED,CREATED],priority:[…],entityGuids:[…]}[,cursor:"…"]){issues{issueId title priority state entityNames activatedAt createdAt} nextCursor}}}}}`.
     The filter and cursor are inlined as GraphQL literals (strings encoded with `JSON.stringify`,
     entity GUIDs validated against `^[A-Za-z0-9+/=_-]{1,200}$`) because the input type names are not
     documented; only `$id` is a variable. UT-043 therefore asserts the filter in the query text, not
     in the variables. The first page has no cursor; later pages pass `nextCursor` until it is empty
     or null (at most 20 pages, else `source_params_invalid` asking to narrow the filters).
  2. `policy_ids` is **dropped** from `newrelic/issues` (`_dx.md` updated): no documented Issue field
     or issue filter carries a policy, and client-side matching is impossible. Operators scope with
     `entity_guids` (and `priorities`). Policy scoping via `aiIssues { incidents(filter: { policyIds }) }`
     is a follow-up once the incident schema is verified. US-002 EC-1 is satisfied for `entity_guids`.
  3. Items carry `title` (the title list joined with `; `), `priority`, `state`, `entityNames`
     (joined with `, `) and `activatedAt` (or `createdAt`) as UTC ISO; US-002 AC-1 "condition" is not
     available on Issue and is omitted. The item link is the region's New Relic UI root (no documented
     issue URL field).
  4. Activeness stays Business Rule 2 and is also checked client-side (state `ACTIVATED`/`CREATED`
     and priority in `priorities`), so a server that ignores a filter cannot widen the set.
  5. `timeWindow` is omitted (its subfield names are not documented), so New Relic's default window
     of the last 24 hours applies. Limitation: an issue that leaves that default window while still
     open drops out of the active set silently; if it later re-enters the window it is reported again.
  6. No `nerd-graph-unsafe-experimental-opt-in` header is sent (not in the public docs).

  Unverified assumptions (operator-run E2E-003): `aiIssues.issues` argument names `filter` and
  `cursor` (and that `cursor` accepts a string literal); the filter keys `states`, `priority`,
  `entityGuids` and the enum literals `ACTIVATED`/`CREATED`; the default 24 h window and what it
  filters on; Issue field names `issueId`, `title`, `priority`, `state`, `entityNames`,
  `activatedAt`, `createdAt`; `nextCursor` being null or empty on the last page; `activatedAt` and
  `createdAt` arriving as epoch milliseconds (number or numeric string; both are parsed).
- **D-5 (alias D-S2-b; 2026-11-15, S2, recorded before coding): errors and logs item details.**
  1. The `newrelic/errors` summary does not carry the `_dx.md` example's "first in window 14:02 UTC":
     the specified query (`SELECT count(*) … FACET appName, error.class, error.message`) returns no
     timestamp. The summary ends with `checked <request.now UTC ISO>` like `newrelic/nrql`.
  2. Event types are de-duplicated and sorted before building `FROM` (stable NRQL and fingerprint).
     Unverified (operator-run E2E-003): `JavaScriptError` rows expose `error.class`/`error.message`;
     if they only carry `errorClass`/`errorMessage`, their class and message read as `null`.
  3. `newrelic/logs` without `facet` titles its item `all logs: …` with key `all` (D-2).
- **D-6 (alias D-S3-a; 2026-11-15, S3, recorded before coding): `alert_issues` follows the public `aiIssues`
  schema.** The `Issue` type has no `conditionName`/`policyName` and its `title` is a list
  (`_research-public-docs.md`), and the `timeWindow` input's field names are undocumented. Change:
  results are `{id, title, priority, state, entities, opened_at, url}` with no `condition`; `title` is
  the incident titles joined with `; `; `state` is `open` (default, `ACTIVATED`/`CREATED`), `closed`
  (`CLOSED`/`DEACTIVATED`) or `all`; `since` (a `5m`–`24h` duration) filters client-side on
  `activatedAt`/`createdAt`, inside NerdGraph's default 24-hour issue window (no `timeWindow` is sent);
  `url` is the region's New Relic UI base (same as `newrelic/nrql` items), since no issue deep-link
  format is verified.
- **D-7 (alias D-S3-b; 2026-11-15, S3, recorded before coding): doctor details `_dx.md` leaves open.** (a) Without
  a bound key the doctor still prints its report (`NerdGraph: failed (<missing-key message>)`,
  `MCP: unknown (no API key)`) and makes no network call, instead of failing as a tool error; (b) the
  startup line values are `nerdgraph=ok|<error code>` and `mcp=available|unavailable:<status>|unknown`
  (no free text, so no key can appear); (c) the probe runs once from the SDK `onReady` callback, so it
  never runs in `__describe` mode or blocks startup; (d) MCP `initialize` sends
  `Accept: application/json, text/event-stream` and accepts a JSON or SSE answer.
- **D-8 (alias D-S4-a; 2026-11-15, S4): OAuth MCP servers use the pre-registered public client and are added to
  the manifest by a packaging step, not the SDK definition.**
  - **Delivery (deviates from Data Models "Manifest additions (via SDK definition)").** CompozyOS 0.7.0
    cannot emit MCP servers for an SDK extension: the describe contract `DescribeResources` has no
    MCP field (`internal/extension/contract/describe.go:70-77`), `decodeDescribePayload` rejects
    unknown fields (`internal/extension/build_describe.go:19-22`), `manifestFromDescribe` copies no
    MCP servers (`build_describe.go:57-64`), and TS SDK 0.7.0 `describe()` drops
    `definition.resources.mcp_servers` (its type is stdio-only: `sdk/typescript/src/types.ts:50-54`).
    Change: `src/mcp-servers.ts` holds the declaration (`MCP_SERVERS`, rendered by
    `mcpServersToml()`). `bun run package` (`scripts/package.ts`) runs `compozy extension build . -o
    json`, copies the generation to `dist/release`, appends the `[resources.mcp_servers.*]` tables to
    its `extension.toml`, and runs `compozy extension validate dist/release`. Local installs, E2E,
    and `compozy extension publish` (S6) must use `dist/release`. A bare `dist/gen-*` has no MCP
    servers. `publish` tars any directory that `LoadManifest` accepts (`internal/extension/publish.go:54-70`),
    and the daemon never re-checks the manifest against describe. `prepareBuildOutput` deletes
    `dist/release` on every build (`build_generation.go:19-34`), so it never leaks into a generation.
  - **Auth fields** (both servers; URLs `https://mcp.newrelic.com/mcp/` and
    `https://mcp.eu.newrelic.com/mcp/`, `transport = "http"`, `default_scope = "workspace"`, no
    headers): `method = "oauth"`, `registration = "pre_registered"`,
    `issuer_url = "https://oauth2.service.newrelic.com"`, `client_id = "pUWGgnjsQ0bydqCbavTPpw=="`,
    `scopes = ["observability:read", "offline_access"]`.
  - **Why pre-registered, not `dynamic`.** CompozyOS maps `dynamic` to `auto`, which tries CIMD
    and then DCR (`internal/mcp/auth/sdk_adapter.go:281-322`). New Relic's DCR returns the same
    fixed client id whatever it is sent (https://github.com/newrelic/mcp-server/issues/7), so DCR only
    adds a network dependency and a persisted registration. `pre_registered` with no secret
    authenticates at the token endpoint as `none` (`internal/mcp/auth/client_auth.go:33-46`), and New
    Relic advertises `token_endpoint_auth_methods_supported: ["none", ...]`. `client_id` requires
    `registration = "pre_registered"` (`internal/config/mcp_server_validation.go:137-170`).
  - **Why this `issuer_url`.** With `pre_registered`, CompozyOS fetches AS metadata directly from
    `issuer_url` and requires its `issuer` to match (`internal/mcp/auth/pre_registered.go:52-73`,
    `issuersEqual` trims a trailing `/`, `types.go:474`). Two endpoints fit:
    `https://oauth2.service.newrelic.com/.well-known/oauth-authorization-server` (issuer
    `https://oauth2.service.newrelic.com`) and `https://mcp.newrelic.com/.well-known/oauth-authorization-server`
    (issuer `https://mcp.newrelic.com`, EU `https://mcp.eu.newrelic.com`). Both point at the same
    `oauth2.service.newrelic.com/oauth2/{auth,token}` endpoints and both advertise S256. The chosen
    one is the server that RFC 9728 protected-resource metadata advertises
    (`https://mcp[.eu].newrelic.com/.well-known/oauth-protected-resource` →
    `authorization_servers: ["https://oauth2.service.newrelic.com"]`), and it is region-independent.
    The authorization request also carries `resource=<server URL>` and the space-joined scopes
    (`internal/mcp/auth/service.go:133-159`).
  - **Redirect URI.** CompozyOS's automatic callback is `mcp.oauth.redirect_uri`, default
    `http://127.0.0.1:2123/api/mcp/oauth/callback` (`internal/config/defaults.go:56`), and it must be
    loopback (`internal/api/core/settings_mcp_auth.go:242-262`). Probed unauthenticated on 2026-11-15
    with `GET https://oauth2.service.newrelic.com/oauth2/auth` (this client_id, S256 challenge,
    `scope=observability:read offline_access`, `resource=https://mcp[.eu].newrelic.com/mcp/`, no
    login, redirects not followed):
    - Passed through to the `login.newrelic.com/?login_challenge=…` login page:
      `http://127.0.0.1:2123/api/mcp/oauth/callback` (US and EU resource),
      `http://localhost:2123/api/mcp/oauth/callback`, `http://127.0.0.1:9999/api/mcp/oauth/callback`,
      and `http://127.0.0.1:2123/callback`.
    - Rejected with `redirect_uri ... does not match any of the OAuth 2.0 Client's pre-registered
      redirect urls`: `http://127.0.0.1:2123/other` and `https://evil.example.com/cb`.

    So loopback works on any port when the path is allowlisted, and the CompozyOS default path is on
    the allowlist. An operator who changed `mcp.oauth.redirect_uri` to another path will be
    rejected.
  - **Validation.** `compozy extension validate dist/release` returns valid. A copy with an invalid
    `registration` value is reported invalid on `resources.mcp_servers.newrelic.auth`, which shows
    that validation reads these tables.
  - **Unverified assumptions (operator-run E2E-004).**
    - Token exchange and refresh: we assume the code exchange with `token_endpoint_auth_method=none`,
      the issued `refresh_token` (`offline_access`; New Relic docs also list `offline`), and the use of
      the bearer token at `mcp[.eu].newrelic.com/mcp/` all succeed. Access tokens last 5 minutes and
      re-login is needed after 24 h, per New Relic docs.
    - Free or disabled account: we assume it fails at login or token exchange (the auth server
      refuses), or at `initialize`/`tools/list` with 401/403. In either case CompozyOS exposes no MCP
      tools. The real failure point is not recorded yet.
    - The redirect allowlist was observed from outside and is not documented by New Relic.
- **D-9 (alias D-S2-c; 2026-11-15, S2 repair, recorded before coding): errors and logs query `LIMIT 501`.** The
  Queries section shows `LIMIT 500`, which makes truncation undetectable and breaks Business Rule 7
  ("never truncates silently"). Change: the `newrelic/errors` and `newrelic/logs` NRQL ends with
  `LIMIT 501`; 501 raw rows (for errors, before regrouping by normalized message) fail with
  `source_params_invalid` and a narrow-the-filter message; exactly 500 rows are accepted. IT-003
  asserts `LIMIT 501`.
- **D-10 (2026-11-15, conductor via E2E-002, recorded by S5 before the README): first use grants the
  extension's tool source.** On a default daemon every `ext__newrelic__*` tool, including
  `compozy extension exec newrelic --cmd doctor`, is denied with `tool_denied` / `source_disabled`,
  because `tools.policy.external_default` defaults to `disabled` (CompozyOS
  `internal/tools/policy.go` `evaluateSourcePolicy`; `docs/configuration/config-toml.mdx`
  `[tools.policy]`). Sources are unaffected: check-ins do not go through the tool policy. Change: the
  First-use flow (User Experience above, `_dx.md` Golden Path, README) gains step 3 "grant the tool
  source" between binding the secret and running the doctor: add
  `[tools.policy] trusted_sources = ["extension:newrelic"]` to the user `config.toml` (path from
  `compozy config path --scope user`) and restart the daemon (`compozy daemon stop`, then
  `compozy daemon start`). Every tool is read-only, so a trusted read-only source is allowed
  (`isTrustedReadOnlySource`). The `compozy config set` writer cannot do this: `tools.policy.*` is a
  trust root (`configPathIsTrustRoot`, `internal/config/tool_surface_security.go`) and has no
  `config set` value kind, so the operator edits the file. The restart is the safe instruction because
  only workspace-scoped policy resolution re-reads config files; the daemon's own snapshot is from
  boot. Alternative: an explicit grant in an agent definition's `tools` list, which narrows that
  agent to the listed tools. The official MCP is a separate grant: a completed
  `compozy mcp auth login newrelic --scope user --owner extension:newrelic` makes its tools callable
  even with `external_default = "disabled"` (`docs/extensions/install.mdx`).

- **D-11 (2026-11-15, repair round 1 / review R-1 and R-11, recorded before coding): the `newrelic/nrql`
  value reader for object-valued aggregates and FACET attributes.** The Queries text ("the first
  numeric field of each row that is not a facet") misreads aggregates that return an object of several
  numbers: `apdex()` returns `{s, t, f, count, score}` and was read as `s` or `count`. Change, for a
  field whose value is an object: (1) a numeric (or null) `score` entry is the value (label `<field>`,
  e.g. `apdex`); (2) `percentile.<attr>` keeps reading its first percentile (label `p<n> <attr>`);
  (3) otherwise an object with exactly one numeric (or null) entry is read as before, and an object
  with more than one numeric entry fails with the shape message (`source_params_invalid`,
  `nrql must return one number per row …`) instead of being misread. Fields whose name is an
  attribute of the query's `FACET` clause (parsed from the text after `FACET` up to `SINCE`, `UNTIL`,
  `LIMIT`, `TIMESERIES`, `COMPARE`, `ORDER`, `WITH`, `EXTRAPOLATE`, `SLIDE` or the end; `AS` aliases
  and backtick quoting handled) are skipped, so an echoed numeric facet attribute is never read as the
  value. Known limitation (final review R-12, deferred nit): a `FACET` clause placed before `WHERE`,
  or the word `FACET` inside a string literal, is not parsed correctly; write `FACET` after `WHERE`.
