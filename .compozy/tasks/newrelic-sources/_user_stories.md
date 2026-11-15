# User Stories: New Relic check-in sources and investigation tools

Canonical behavior catalog for the `newrelic` extension. Companion to `_spec.md`; consumed by
`_spec.md` Part II and `_tests.md`. No UI of its own: CompozyOS renders sources, tools, and MCP
servers generically.

## Personas

- **Operator**: a CompozyOS user who runs always-on agents and wants them woken only when New Relic
  shows something new (an alert, a new error, a log spike, a metric breach), without spending model
  turns on quiet hours.
- **Agent**: the always-on agent that receives items at check-in and then investigates with tools.
  It must only see tools that work for the installer's plan and credentials.
- **Installer**: anyone installing `github:jillesmc/compozy-newrelic` on Linux or macOS, on any New
  Relic plan (free included).

## Story Index

| ID     | Feature Area  | Persona   | Story                                                                 |
| ------ | ------------- | --------- | --------------------------------------------------------------------- |
| US-001 | Sources       | Operator  | Be woken when any NRQL metric starts breaching a threshold            |
| US-002 | Sources       | Operator  | Be woken when a New Relic alert issue opens                           |
| US-003 | Sources       | Operator  | Be woken when an error type appears or crosses a count                |
| US-004 | Sources       | Operator  | Be woken when a log group starts exceeding a count                    |
| US-005 | Sources       | Operator  | Start quietly and choose whether to hear about what is already active |
| US-006 | Sources       | Agent     | Receive compact, sourced items without raw log or error payloads      |
| US-007 | Operate       | Operator  | Bind one API key, pick the region, and see deterministic errors       |
| US-008 | Investigation | Agent     | Investigate with tools that work on any plan                          |
| US-009 | Investigation | Operator  | Unlock the official MCP only when the account can use it              |
| US-010 | Investigation | Operator  | Learn, without spending agent tokens, whether the MCP is available    |
| US-011 | Distribute    | Installer | Install a published release on Linux or macOS                         |

## Sources

### US-001: Metric threshold (`newrelic/nrql`)

**As an** operator, **I want** to write any NRQL that returns numbers (optionally faceted) and a
threshold, **so that** my agent is woken when a value starts breaching it.

Acceptance criteria:

- AC-1: Given `nrql: SELECT percentile(duration, 95) FROM Transaction WHERE appName = 'checkout-api' SINCE 15 minutes ago`,
  `condition: above`, and `threshold: 1.5`, when p95 goes from 1.2 to 2.31, then the next check returns
  one item titled `checkout-api p95 above 1.5: 2.31`-style (see `_dx.md`).
- AC-2: Given the value stays above 1.5 on later checks, then no further item is returned.
- AC-3: Given the value drops to 1.1 and later rises to 1.9, then a new item is returned on the rise.
- AC-4: Given a `FACET appName` query, each facet value breaches and recovers independently.
- AC-5: `condition: below` works symmetrically (e.g. throughput below a floor).

Edge cases:

- EC-1: NRQL is invalid → `source_params_invalid` with New Relic's error text, shortened.
- EC-2: NRQL returns no numeric value (e.g. `SELECT *`) → `source_params_invalid` naming the expected
  shape (one number per row).
- EC-3: NRQL returns more than 500 rows → `source_params_invalid` asking to add `LIMIT` or narrow the facet.
- EC-4: A row's value is null (no data) → treated as not breaching.
- EC-5: NRQL query times out in New Relic → `source_extension_failed`; state unchanged; daemon retries.

### US-002: Alert issues (`newrelic/issues`)

**As an** operator, **I want** to be woken when a New Relic alert issue opens with the priorities I
care about, **so that** my agent reacts to real incidents.

Acceptance criteria:

- AC-1: Given `priorities: [CRITICAL, HIGH]`, when a CRITICAL issue activates, then the next check
  returns one item with its title, priority, entities, condition, and link.
- AC-2: A LOW issue never produces an item under that filter.
- AC-3: An issue that stays open produces no further item; once closed it leaves the tracked set.

Edge cases:

- EC-1: `entity_guids` or `policy_ids` given → only matching issues count.
- EC-2: An issue reopens with the same id after closing → returned again.
- EC-3: More open issues than fit the tracked capacity → `source_params_invalid` asking to narrow filters.

### US-003: Errors (`newrelic/errors`)

**As an** operator, **I want** to be woken when an error type shows up in my app or crosses a count
in a window, **so that** regressions reach my agent fast.

Acceptance criteria:

- AC-1: Given `where: appName = 'checkout-api'`, `window: 30m`, `min_count: 10`, when `TimeoutError`
  occurs 37 times in 30 minutes, then one item `TimeoutError in checkout-api: 37 in 30m` is returned.
- AC-2: The error type key is `appName` + `error.class` + normalized `error.message` (digits, hex ids,
  UUIDs, and quoted values collapsed), so `Order 123 not found` and `Order 456 not found` are one type.
- AC-3: Default `event_types: [TransactionError]`; `JavaScriptError` may be added.
- AC-4: A type that falls below `min_count` leaves the tracked set and can produce a new item later.

Edge cases:

- EC-1: `min_count` default 1 → any new type in the window is reported once.
- EC-2: Error messages are never copied in full into items: at most 160 characters of the normalized
  message.

### US-004: Logs (`newrelic/logs`)

**As an** operator, **I want** to be woken when a log group (e.g. per service) starts exceeding a
count for a filter like `level = 'error'`, **so that** log spikes reach my agent.

Acceptance criteria:

- AC-1: Given `where: level = 'error'`, `facet: service.name`, `window: 15m`, `threshold: 50`, when
  `payments` logs 120 errors in 15 minutes, then one item `payments: 120 log lines in 15m (threshold 50)`.
- AC-2: Items carry counts and facet values only, never raw log lines.

Edge cases:

- EC-1: `facet` omitted → one group for the whole filter.
- EC-2: The facet attribute does not exist → New Relic returns no rows → nothing breaches (documented).

### US-005: Quiet start

**As an** operator, **I want** the first check (and the first after changing a source's parameters)
to record what is already active without reporting it, unless I ask, **so that** turning a source on
never floods my agent.

Acceptance criteria:

- AC-1: Default: the baseline check returns 0 items and commits the active set.
- AC-2: `notify_existing: true` → the baseline check also returns everything already active.
- AC-3: Changing any parameter that defines the signal (`account_id`, `region`, query, filters,
  thresholds, window) starts a new quiet baseline.

### US-006: Compact items

**As an** agent, **I want** items that name the account, signal, value, and a link, **so that** I can
decide and investigate without guessing which query produced them.

Acceptance criteria:

- AC-1: Every item has a stable key, a title of at most 200 characters, a summary of at most 1 KiB,
  and attributes of at most 2 KiB including `account_id`, `region`, `kind`, `value`, `threshold` (when
  any), `facet`, and the NRQL (truncated) that produced it.
- AC-2: Items never contain the API key.

## Operate

### US-007: Credentials, region, errors

**As an** operator, **I want** to bind one New Relic User API key and pick US or EU per source, **so
that** setup is one secret and errors tell me what to fix.

Acceptance criteria:

- AC-1: `compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` is the only credential step
  for sources and investigation tools.
- AC-2: `region` defaults to `us`; `eu` switches NerdGraph to the EU endpoint.
- AC-3: Missing key → `source_credential_absent`; 401/403 auth failure → `source_credential_expired`;
  429 → `source_rate_limited`; GraphQL/NRQL errors → `source_params_invalid` with the message.

Edge cases:

- EC-1: Key lacks access to `account_id` → `source_params_invalid` naming the account.
- EC-2: A License/Ingest key (not `NRAK-`) is bound → `source_credential_expired` with a hint to use a User key.

## Investigation

### US-008: Plan-independent tools

**As an** agent, **I want** read-only tools that work with the bound API key on any plan, **so that**
every tool I see actually works.

Acceptance criteria:

- AC-1: Tools `nrql_query`, `list_accounts`, `search_entities`, `alert_issues`, `error_groups`,
  `recent_logs` are available after the key is bound, on free and paid plans.
- AC-2: Each result is compact and bounded (at most 50 rows and 8 KiB of text).
- AC-3: No tool exists that needs OAuth or a paid feature.

Edge cases:

- EC-1: Tool called without a bound key → structured error naming the secrets command, no network call.
- EC-2: `recent_logs` truncates each message to 300 characters and never returns more than 50 lines.

### US-009: Official MCP only when usable

**As an** operator, **I want** the official New Relic MCP (with its AI tools) to reach my agents only
after I sign in with OAuth on an account that has MCP access, **so that** agents never see tools that
fail with 403.

Acceptance criteria:

- AC-1: After install, the MCP servers `newrelic` (US) and `newrelic-eu` (EU) are declared but expose
  no tools until `compozy mcp auth login newrelic` (or `newrelic-eu`) completes.
- AC-2: On a paid account with MCP enabled, after login, the MCP tools (including
  `natural_language_to_nrql_query`) are callable.
- AC-3: On a free account or without the admin toggle, no MCP tool becomes callable (login or tool
  listing fails); the investigation tools of US-008 remain.

### US-010: Operator diagnosis

**As an** operator, **I want** to know whether my account can use the MCP without asking an agent,
**so that** I only sign in when it will work.

Acceptance criteria:

- AC-1: `compozy extension exec newrelic --cmd doctor` reports NerdGraph access (accounts visible),
  region, and MCP availability (`available`, `unavailable: <reason>`, or `unknown`) with the next step.
- AC-2: At extension start, the same probe runs once and its one-line result appears in
  `compozy extension logs newrelic`.

## Distribute

### US-011: Install a release

**As an** installer, **I want** `compozy extension install github:jillesmc/compozy-newrelic@v0.1.0`
to work on Linux and macOS with Node.js 22+, **so that** I can use it without building.

Acceptance criteria:

- AC-1: After install, `newrelic/nrql`, `newrelic/issues`, `newrelic/errors`, `newrelic/logs` are
  listed as check-in sources and the six tools are listed.
