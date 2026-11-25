# compozy-newrelic

> **Experimental (0.x).** See [Compatibility](#compatibility).

A [CompozyOS](https://github.com/compozy/compozy) extension named `newrelic`. It does four things:

- **Four check-in sources** wake an always-on agent only when New Relic shows something new:
  `newrelic/nrql` (metric threshold), `newrelic/issues` (alert issues), `newrelic/errors` (new error
  types) and `newrelic/logs` (log spikes). A quiet check costs no model turn.
- **Six read-only investigation tools** (`ext__newrelic__*`) backed by NerdGraph. They work with a
  User API key on every plan, free included.
- **An API-key proxy to the official New Relic MCP** (`ext__newrelic__mcp_tools` and
  `ext__newrelic__mcp_call`). Agents list and call every official MCP tool that works with the bound
  key, and never see one that cannot.
- **The official New Relic MCP via OAuth** (`newrelic`, US; EU accounts add `newrelic-eu` by hand),
  for the OAuth-only tools.
  Its tools reach agents only after a successful OAuth sign-in on an account that can use them.

A `doctor` command tells you, without spending agent tokens, whether your account can use the
official MCP. The extension has nine tools including the doctor, and never writes to New Relic.

## Requirements

- CompozyOS 0.7.0 or newer. Older daemons refuse the install with a version error.
- Node.js 22 or newer on the daemon's `PATH`. The extension is one JavaScript file run by `node`.
- Linux or macOS.
- A New Relic **User API key** (`NRAK-…`). License and ingest keys do not work.

## Install

Install it for all projects:

```bash
compozy extension install github:jillesmc/compozy-newrelic@v0.6.0 --allow-unverified --yes
```

Without `--scope` the install is global: the packaged MCP servers default to global scope (v0.1.0
needed `--scope global`). To install into a single project instead, add
`--scope workspace --workspace <id|name|path>`.

The consent flags are required: GitHub installs are not catalog-verified, so CompozyOS refuses them
with `extension_checksum_unverified` unless you pass `--allow-unverified` (`--yes` skips the prompt).
The release's `.sha256` sidecar is still checked for integrity, and `--expected-digest <sha256>` pins
the exact archive you reviewed.

Upgrade later with the same consent:

```bash
compozy extension update newrelic --allow-unverified --yes
```

## Bind the API key

Create a User API key in New Relic (one.newrelic.com → user menu → **API keys** → key type
**User**). Bind it, then restart the extension so it receives the secret:

```bash
compozy extension secrets set newrelic --env NEW_RELIC_API_KEY   # hidden input
compozy extension disable newrelic && compozy extension enable newrelic
```

This one secret serves every source and tool, including the MCP proxy. The OAuth servers do not use
it; they sign in with OAuth (see [Official MCP via OAuth](#official-mcp-via-oauth)).

## Per-project values

Each project carries its own New Relic app and default account in a file this extension owns,
versioned in the project repository:

```toml
# <workspace root>/.compozy/newrelic.toml
app = "acme-api-prod"     # fills {{app}}; no quotes or backslashes
account_id = 1234567      # positive integer; default account for sources and tools
```

Values resolve in this order, first hit wins:

1. An explicit parameter: `with.app` / `with.account_id` / `with.account_ids` on a source, `app` /
   `account_id` / `account_ids` on a tool (`account_id` wins over `account_ids`).
2. `.compozy/newrelic.toml` under the workspace root: `accounts`, then `account_id`.
3. `NEW_RELIC_ACCOUNT_ID` (account only; an optional standalone default).

Check-in sources read the file under the poll's workspace root, so one shared `HEARTBEAT.md` with
`where: "appName = '{{app}}'"` serves every project. Tools read it under the call's trusted
workspace (sessions running in a workspace); a call without one reads no file and uses only explicit
parameters and `NEW_RELIC_ACCOUNT_ID`.

The app is inserted literally. There is no global app fallback.

The file is a deliberately narrow subset of TOML. Anything outside these rules is rejected with
`source_params_invalid: .compozy/newrelic.toml: <reason>` (tools: `tool_invalid_input`), and no query
is sent:

- Each non-blank line is a `#` comment or `key = value`, optionally followed by a `# comment`.
- Keys: letters, digits, `_` and `-`, each at most once. No tables (`[...]`) or inline tables; the
  only array is `accounts`.
- `app`: a `"double-quoted"` or `'single-quoted'` string of 1 to 256 characters, with no `'`, `"` or
  `\` and no escape sequences. The same 256-character and quote rules apply to `with.app` / `app`.
- `account_id`: a positive integer written as plain digits (`1234567`; `1_234_567` is rejected).
- `accounts`: `[<id>, <id>, ...]` on one line, 1 to 20 positive integers, no trailing comma.
- Any other key: a quoted string with no `;`, `{{` or `}}` and no escape sequences.
- Size: at most 4096 bytes (4 KiB).
- `.compozy` must be a real directory and `newrelic.toml` a regular file. A symbolic link at
  `.compozy` or at `newrelic.toml` is rejected, as are FIFOs and other special files, and the file is
  read through one no-follow descriptor whose type and size are checked before any read. A process
  that can rewrite the workspace while it is being read is out of scope: it can already set the
  values in the file directly.

To set the optional account default (`NEW_RELIC_ACCOUNT_ID` appears in `requires_env` because SDK 0.7.0
has no optional-env field; the extension runs without it, and status lists it as missing until set):

```bash
printf '1234567' | compozy extension secrets set newrelic --value-stdin --env NEW_RELIC_ACCOUNT_ID
```

### Placeholders and several accounts

Since 0.6.0 the file also takes `accounts` and any other string key (spec deviation D-24). This is
for a project with no New Relic app of its own whose signals are emitted by its consumers, in more
than one account. For example, a migration library used as a base image by many services, whose
consumers log `global_event_name = 'MIGRATION'` in production and staging:

```toml
# <library repo>/.compozy/newrelic.toml
accounts = [317703, 2656688]     # production and staging; queried together
logs_where = "global_event_name = 'MIGRATION' AND level = 'ERROR'"
logs_facet = "service_name, step"
```

A shared check-in source then picks these up, and stays silent in every project that does not set
them:

```yaml
- id: nr-scope
  kind: newrelic/logs
  with:
    where: "{{logs_where}}"
    facet: "{{logs_facet}}"
    window: "24h"
    threshold: 3
```

In this library it runs `SELECT count(*) FROM Log WHERE global_event_name = 'MIGRATION' AND level =
'ERROR' FACET accountId(), service_name, step SINCE 1440 minutes ago LIMIT 501` once over both
accounts, and wakes the agent with items such as `317703/orders-api/apply` and
`2656688/orders-api/apply`: the same failure in production and in staging are two items, each naming
its account.

- **Placeholders.** `{{<key>}}` in `where` and `facet` (sources and tools) is replaced by any string
  key of the file; `with.app` / `app` still wins for `{{app}}`. The value is inserted verbatim, in a
  single pass (an inserted value is never expanded again).
- **A key the project does not set** (any `{{...}}` with no value, including `{{app}}` with no app
  anywhere): the source returns no items, keeps its state, sends no query and writes one line
  `newrelic/<kind> skipped: with.where uses {{logs_where}}; set logs_where in .compozy/newrelic.toml`
  to `compozy extension logs newrelic` (key names only, never values). A tool fails with
  `tool_invalid_input` and the same reason.
- **Injection.** Values are NRQL written by whoever owns the project repository, inserted as is. A
  value must not contain `;` (no second statement) or `{{` / `}}`, and a value is always one line.
  `app` keeps its stricter rules because it lands inside a string literal.
- **`accounts`.** With two or more ids, the NRQL runs once, cross-account (NerdGraph
  `actor { nrql(accounts: [...]) }`). `newrelic/logs` and `newrelic/errors` put `accountId()` first
  in their `FACET` and key items `<account>/<group>` (`<account>/all` without a facet);
  `newrelic/issues` reads each account in turn and keys items `<account>/<issue id>`;
  `newrelic/nrql` runs your NRQL as written (add `FACET accountId()` to split by account). With one
  id, everything is exactly as with `account_id`. `nrql_query` and `recent_logs` also use `accounts`;
  `alert_issues` and `error_groups` read one account and skip it (they use `account_id`).

### Migrating from 0.3.x

**BREAKING (0.4.0): `NEW_RELIC_APP` is removed** and ignored if still set. Put `app` (and
`account_id`) in `<project>/.compozy/newrelic.toml`, or pass `with.app` / `app`. Then:

```bash
compozy extension secrets unset newrelic --env NEW_RELIC_APP
```

Until a project has the file (or the source passes `with.app`), a source whose `where` uses `{{app}}`
returns no items (since 0.6.0; 0.4.x and 0.5.x failed with `source_params_invalid`) and logs
`newrelic/<kind> skipped: with.where uses {{app}}; set app in .compozy/newrelic.toml or with.app`.
The account precedence also changed: the project file's `account_id` now wins over
`NEW_RELIC_ACCOUNT_ID`, and the investigation tools take `account_id` from the file or the env when
omitted.

## Grant the tools

On a default daemon every `ext__newrelic__*` tool, including the doctor, is denied with
`tool_denied` (`source_disabled`). That is because `tools.policy.external_default` defaults to
`disabled`. The check-in sources work without this step; the tools and the doctor need it.

All tools, including the MCP proxy, are read-only, so you can mark the extension as a trusted
read-only source. Add this to your user `config.toml` (`compozy config path --scope user` prints its path):

```toml
[tools.policy]
trusted_sources = ["extension:newrelic"]
```

Then restart the daemon:

```bash
compozy daemon stop && compozy daemon start
```

`compozy config set` cannot write this key: `tools.policy` is a trust root, so you edit the file
yourself. To grant the tools to a single agent instead, list them in that agent definition's
`tools`. Note that this limits the agent to the tools you list.

## Doctor

```bash
compozy extension exec newrelic --cmd doctor            # US region
compozy extension exec newrelic --cmd doctor --region eu
```

```text
NerdGraph: ok (region us, 21 accounts visible)
MCP: available (35 tools exposed via API key; 2 OAuth-only hidden) — agents can use ext__newrelic__mcp_tools / mcp_call
```

`N tools exposed` is what [the proxy](#official-mcp-via-the-api-key-proxy) offers agents with this
key. `M OAuth-only hidden` counts the tools that need an OAuth sign-in; tools New Relic does not mark
read-only are hidden too but not counted here.

On a free account, or when the MCP admin toggle is off:

```text
NerdGraph: ok (region us, 1 account visible)
MCP: unavailable (403 from https://mcp.newrelic.com/mcp/) — agents keep the ext__newrelic__* tools; skip the MCP login
```

`MCP: unknown (<reason>)` means the probe could not decide (network error or timeout). Run it again
later. The doctor never fails because of the MCP, and it makes no network call when no key is bound.
It probes the MCP with `initialize` and `tools/list` (10 s per request) and never calls an MCP tool.

The same probe runs once when the extension starts and writes one line to
`compozy extension logs newrelic`:

```text
newrelic: probe region=us nerdgraph=ok mcp=available
```

The startup line always probes the US region. EU accounts run
`compozy extension exec newrelic --cmd doctor --region eu`.

## Golden path

Add sources to an always-on agent's `HEARTBEAT.md` (with managed authoring or on the Heartbeat page):

```markdown
---
version: 1
preferences:
  min_interval: "15m"
context:
  include: []
  sources:
    - id: nr-alerts
      kind: newrelic/issues
      with:
        account_id: 1234567
        priorities: [CRITICAL, HIGH]
    - id: checkout-errors
      kind: newrelic/errors
      with:
        account_id: 1234567
        where: "appName = 'checkout-api'"
        window: "30m"
        min_count: 10
    - id: checkout-p95
      kind: newrelic/nrql
      with:
        account_id: 1234567
        nrql: "SELECT percentile(duration, 95) FROM Transaction WHERE appName = 'checkout-api' FACET appName SINCE 15 minutes ago"
        condition: above
        threshold: 1.5
    - id: error-logs
      kind: newrelic/logs
      with:
        account_id: 1234567
        region: us
        where: "level = 'error'"
        facet: service.name
        window: "15m"
        threshold: 50
---

For each New Relic item, investigate with the ext__newrelic__* tools (ext__newrelic__mcp_tools and
ext__newrelic__mcp_call reach the official New Relic MCP tools). Propose "Investigate <key>" with a
one-paragraph hypothesis. Stay quiet when it recovers.
```

Save it and run a dry check. The first check is a **quiet baseline**: it records what is already
active and reports nothing.

```bash
compozy agent instance check sre-watch --workspace my-project --dry-run
```

```text
Would run: no
Sources:
  nr-alerts        newrelic/issues  ok  0 items  (512 ms)
  checkout-errors  newrelic/errors  ok  0 items  (733 ms)
  checkout-p95     newrelic/nrql    ok  0 items  (690 ms)
  error-logs       newrelic/logs    ok  0 items  (801 ms)
Digest:
```

Later, when p95 crosses the threshold, the next check wakes the agent with one item:

```text
Would run: yes
Sources:
  checkout-p95  newrelic/nrql  ok  1 item  (702 ms)
Digest:
  source:checkout-p95:checkout-api  checkout-api above 1.5: 2.31 (p95 duration, account 1234567)
```

While p95 stays above 1.5, later checks stay quiet. If it recovers and breaches again, you get a new
item.

## How "new" works

Each check computes the set of **active signals**: the keys whose value meets the source's
condition. Only keys that are active now and were not active at the previous check produce items.

- A signal that stays active never wakes the agent again.
- A signal that recovers drops out silently. If it becomes active later, it is reported again.
- The first check, and the first check after you change a parameter that defines the signal (account,
  region, query, filters, threshold, window), is a quiet baseline. Set `notify_existing: true` to
  also receive what is already active at the baseline. Changing only `notify_existing` does not
  re-baseline.
- At most `max_items` items come per check, the most severe first. The rest arrive on the next check
  (`more: true`); nothing is dropped.

## Source reference

Every kind accepts these parameters:

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `account_id` | integer | `.compozy/newrelic.toml`, then `NEW_RELIC_ACCOUNT_ID` | New Relic account to query; required when nothing sets an account. Wins over `account_ids`. |
| `account_ids` | integer[] (1–20) | `accounts` in `.compozy/newrelic.toml` | Query these accounts together (see [Placeholders and several accounts](#placeholders-and-several-accounts)). |
| `app` | string | `.compozy/newrelic.toml` | Fills `{{app}}` in `where` (see [Per-project values](#per-project-values)). |
| `region` | `us` \| `eu` | `us` | NerdGraph endpoint (`api.newrelic.com` or `api.eu.newrelic.com`). |
| `notify_existing` | bool | `false` | Report what is already active at the baseline. |

Windows are `<n>m` or `<n>h`, from `5m` to `24h`. The source adds `SINCE <window> ago` itself.

### `newrelic/nrql` — NRQL threshold

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `nrql` | string | required | Any NRQL that returns one number per row, optionally with `FACET`. Used verbatim, including its own `SINCE`. |
| `condition` | `above` \| `below` | `above` | Breach direction. |
| `threshold` | number | required | Breach boundary, strict (`>` for `above`, `<` for `below`). |

- Key: the facet values joined with `/`, or `all` when the query has no `FACET`.
- The value is the first numeric field of each row, skipping the facet, time buckets and the
  attributes named in the query's `FACET` clause (D-11). Aggregates that return an object are read
  this way: `apdex()` reads its score, and `percentile(x, 95)` reads as `p95 x`. An object holding
  a single number reads as that number. An object holding several numbers fails with the shape
  message, so the value is never guessed. A null value (no data) never breaches.
- More than 500 rows fail with `source_params_invalid`; add `LIMIT` or narrow the `FACET`.
- Item: `checkout-api above 1.5: 2.31 (p95 duration, account 1234567)`.

### `newrelic/issues` — New Relic alert issues

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `priorities` | string[] (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) | `[CRITICAL, HIGH]` | Issue priorities that count. |
| `entity_guids` | string[] | none | Only issues on these entities. |

- Active: state `ACTIVATED` or `CREATED`, with a listed priority. Key: the issue id (`<account>/<issue id>`
  when several accounts are queried; each account is read in turn).
- Order: CRITICAL > HIGH > MEDIUM > LOW, then oldest first.
- Item: `CRITICAL issue: <incident titles>`, with priority, state, entities and activation time.
- There is no `policy_ids` filter; see [Limitations](#limitations).

### `newrelic/errors` — New errors

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `where` | string | none | NRQL `WHERE` body, without the `WHERE` keyword; `{{app}}` and other `{{key}}` placeholders expand from the project file. |
| `event_types` | string[] (`TransactionError`, `JavaScriptError`) | `[TransactionError]` | Event types to count. |
| `window` | duration | `30m` | Counting window. |
| `min_count` | integer ≥ 1 | `1` | Occurrences in the window that make an error type active. |

- An error type is app + `error.class` + normalized `error.message`. Digit runs, hex ids of 8 or more
  characters, UUIDs and quoted strings collapse to `#`, so `Order 123 not found` and
  `Order 456 not found` are one type.
- Key: `app/class/<8 hex of the normalized message hash>`, prefixed `<account>/` when several
  accounts are queried.
- Item: `TimeoutError in checkout-api: 37 in 30m`. It carries at most 160 characters of the
  normalized message and never a stack trace.

### `newrelic/logs` — Log spikes

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `where` | string | required | NRQL `WHERE` body over `Log`; `{{app}}` and other `{{key}}` placeholders expand from the project file. |
| `facet` | string | none | Attributes to group by, comma-separated (for example `service.name` or `service_name, step`); placeholders expand. |
| `window` | duration | `15m` | Counting window. |
| `threshold` | integer ≥ 0 | required | Lines in the window that make a group active (strict `>`). |

- Key: the facet values joined with `/` (`orders-api/apply`), or `all` without `facet`; prefixed
  `<account>/` when several accounts are queried. A facet that does not exist returns no rows, so
  nothing breaches.
- Item: `payments: 120 log lines in 15m (threshold 50)`. Items carry counts and facet values only,
  never log lines.

### Items

Every item names the account, region, signal and value and links to the New Relic UI. The title is
at most 200 characters, the summary at most 1 KiB and the attributes at most 2 KiB. Agents receive
items as untrusted, fenced data. Example (`newrelic/errors`):

```json
{
  "key": "checkout-api/TimeoutError/7f3a91c2",
  "title": "TimeoutError in checkout-api: 37 in 30m",
  "summary": "New error type · account 1234567 (us) · 37 in 30m (min 10) · checked 2026-11-14T14:05:00.000Z · message: Upstream timed out after # ms calling #",
  "url": "https://one.newrelic.com/errors-inbox",
  "attributes": {
    "kind": "errors",
    "account_id": 1234567,
    "region": "us",
    "app": "checkout-api",
    "class": "TimeoutError",
    "message": "Upstream timed out after # ms calling #",
    "count": 37,
    "window": "30m",
    "min_count": 10
  }
}
```

### Limits and configuration

No new config keys. The existing `[agents.heartbeat.sources]` keys apply:

| Key | Default | Effect |
| --- | --- | --- |
| `agents.heartbeat.sources.max_items` | 20 | Items per check; the rest follow on the next check. |
| `agents.heartbeat.sources.max_state_bytes` | 16384 | The whole active set must fit. A source with more active signals fails with `source_params_invalid` (`<n> active signals do not fit max_state_bytes=…; narrow the source`); it never truncates. |
| `agents.heartbeat.sources.timeout` | 30 s | One poll's deadline. Each poll stays under 25 s and each request under 10 s. |

Each poll runs one NRQL query (`newrelic/nrql`, `errors`, `logs`, also when cross-account) or one to
20 issue pages per account.
A `min_interval` of 5 minutes or more is a sensible floor.

### Errors

| Condition | Code | Message |
| --- | --- | --- |
| `NEW_RELIC_API_KEY` not bound | `source_credential_absent` | `New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` |
| Key rejected (401/403), or not an `NRAK-` user key | `source_credential_expired` | `New Relic rejected the API key; bind a User API key (NRAK-...)` |
| 429 | `source_rate_limited` | `New Relic rate limit reached; retry later` |
| NRQL or GraphQL error | `source_params_invalid` | `New Relic rejected the query: <message, at most 300 characters>` |
| No `account_id` anywhere | `source_params_invalid` | `set with.account_id, account_id in .compozy/newrelic.toml, or NEW_RELIC_ACCOUNT_ID` |
| `{{key}}` in `where` or `facet` that nothing sets | none: no items, state kept, one `skipped` log line | `with.where uses {{app}}; set app in .compozy/newrelic.toml or with.app` |
| App with `'`, `"` or `\` | `source_params_invalid` | `with.app must not contain quotes or backslashes` (or `.compozy/newrelic.toml: app ...`) |
| Malformed `.compozy/newrelic.toml` | `source_params_invalid` | `.compozy/newrelic.toml: <reason>` |
| No access to `account_id` | `source_params_invalid` | `this API key cannot read account 1234567` (several: `cannot read every account of 317703, 2656688`) |
| NRQL result not one number per row | `source_params_invalid` | `nrql must return one number per row (e.g. SELECT count(*) ... FACET x)` |
| More than 500 rows | `source_params_invalid` | `nrql returned more than 500 rows; add LIMIT or narrow the FACET` |
| Active set over `max_state_bytes` | `source_params_invalid` | `<n> active signals do not fit max_state_bytes=16384; narrow the source` |
| 5xx, network error, request timeout (10 s) | `source_extension_failed` | `New Relic request failed: <status or error>` |

A failed poll returns no partial items and leaves the state unchanged; the daemon retries on the
next check. Each failure writes one line with the code and HTTP status to
`compozy extension logs newrelic`, never the key, the query or the results.

## NRQL gallery

Ready-made `newrelic/nrql` sources. Replace the app names and thresholds with your own.

**p95 latency per app (seconds), above 1.5:**

```yaml
nrql: "SELECT percentile(duration, 95) FROM Transaction FACET appName SINCE 15 minutes ago LIMIT 100"
condition: above
threshold: 1.5
```

**Error rate (%), above 5:**

```yaml
nrql: "SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName = 'checkout-api' SINCE 15 minutes ago"
condition: above
threshold: 5
```

**Throughput drop (requests per minute), below 100:**

```yaml
nrql: "SELECT rate(count(*), 1 minute) FROM Transaction WHERE appName = 'checkout-api' SINCE 15 minutes ago"
condition: below
threshold: 100
```

**Apdex per app (T = 0.5 s), below 0.85:**

```yaml
nrql: "SELECT apdex(duration, t: 0.5) FROM Transaction FACET appName SINCE 15 minutes ago LIMIT 100"
condition: below
threshold: 0.85
```

`apdex()` returns several numbers, and the source reads its `score`. The same Apdex can also be
written out as plain arithmetic:
`SELECT (filter(count(*), WHERE duration <= 0.5) + filter(count(*), WHERE duration > 0.5 AND duration <= 2) / 2) / count(*) FROM Transaction FACET appName SINCE 15 minutes ago LIMIT 100`.

**Infrastructure CPU per host (%), above 90:**

```yaml
nrql: "SELECT average(cpuPercent) FROM SystemSample FACET hostname SINCE 10 minutes ago LIMIT 200"
condition: above
threshold: 90
```

Leave a margin between the threshold and normal values. A value that hovers around the threshold
wakes the agent on every re-entry.

## Tools reference

All tools are read-only and compact. The NerdGraph tools return at most 50 rows (25 for entities,
issues and error groups) and 8 KiB of text; the [MCP proxy](#official-mcp-via-the-api-key-proxy) has
its own bounds. `truncated` is set when something was cut. Every tool accepts `region` (`us`
default, or `eu`).

| Tool | Input | Returns |
| --- | --- | --- |
| `ext__newrelic__nrql_query` | `nrql`, `account_id?`, `account_ids?` (1–20; cross-account, add `FACET accountId()` to split) | Up to 50 rows as a compact table; nested aggregates become dotted columns (`percentile.duration.95`). |
| `ext__newrelic__list_accounts` | — | Up to 50 `{id, name}`. |
| `ext__newrelic__search_entities` | `query` (a name, or a NerdGraph entity search such as `domain = 'APM' AND name LIKE 'checkout'`) | Up to 25 `{guid, name, type, domain, alert_severity}`. |
| `ext__newrelic__alert_issues` | `account_id?`, `state?` (`open` default, `closed`, `all`), `priorities?`, `since?` (≤ `24h`) | Up to 25 `{id, title, priority, state, entities, opened_at, url}`, highest priority and newest first; `url` opens that issue. |
| `ext__newrelic__error_groups` | `account_id?`, `app?`, `where?`, `window?` (`30m` default) | Up to 25 `{app, class, message (≤ 160), count, last_seen}`, most frequent first. |
| `ext__newrelic__recent_logs` | `account_id?`, `account_ids?` (1–20), `app?`, `where`, `window?` (`15m` default), `limit?` (1–50, default 20) | Lines `{timestamp, service, level, message (≤ 300)}`. |
| `ext__newrelic__mcp_tools` | `query?`, `limit?` (1–60, default 60) | The official MCP tools usable with the key; see [the proxy](#official-mcp-via-the-api-key-proxy). |
| `ext__newrelic__mcp_call` | `tool`, `arguments?` (≤ 64 KiB) | One official MCP tool's result, text ≤ 16 KiB. |
| `ext__newrelic__doctor` | — | The doctor report. It is an operator command; its description tells agents not to call it. |

`account_id?` and `app?` default from [per-project values](#per-project-values) when the call has a
trusted workspace, then `account_id` from `NEW_RELIC_ACCOUNT_ID`.

Without a bound key, the investigation and proxy tools return a `credential_absent` error that
names the secrets command, and they make no network call.

Tool errors reach agents as three lines: the CompozyOS code with its fixed text, then `Cause:` (the
extension code and message from the source [Errors](#errors) table), then `Recovery:`. For example:

```text
tool_unavailable: tool unavailable
Cause: credential_absent: New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY
Recovery: run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY
```

| Cause starts with | First line | Recovery |
| --- | --- | --- |
| `credential_absent` | `tool_unavailable: tool unavailable` | `run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` |
| `credential_expired` | `tool_unavailable: tool unavailable` | `bind a User API key (NRAK-...) with compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` |
| `rate_limited` | `tool_unavailable: tool unavailable` | `retry later` |
| `params_invalid` | `tool_invalid_input: invalid tool request` | `fix the named parameter and call the tool again` |
| `extension_failed` (timeout, or the 25 s tool budget) | `tool_timed_out: tool call timed out` | `retry with a narrower query or time window` |
| `extension_failed` (5xx, network) | `tool_backend_failed: tool backend failed` | `retry later; if it keeps failing, run compozy extension exec newrelic --cmd doctor` |

## Plan matrix

| Capability | Free plan | Paid plan | Credential |
| --- | --- | --- | --- |
| Check-in sources (`newrelic/*`) | yes | yes | User API key |
| NerdGraph investigation tools (`ext__newrelic__*`) | yes | yes | User API key |
| Doctor | yes | yes | User API key |
| Official MCP through the proxy (`mcp_tools`, `mcp_call`) | no: `mcp_unavailable` | yes, read-only tools that work with the key | User API key |
| Official MCP (`newrelic`; `newrelic-eu` by hand) | no | yes, with the role and admin toggle below | OAuth sign-in |
| OAuth-only MCP tools (for example `natural_language_to_nrql_query`) | no | yes | OAuth sign-in |

On a free account, or one where the MCP is not enabled, the proxy tools answer `mcp_unavailable` at
once and the NerdGraph tools keep working. With an API key, New Relic lists the OAuth-only tools but
rejects calls to them with 403, so the proxy hides them instead of letting agents spend tokens on
them.

## Official MCP via the API-key proxy

Two tools reach the official New Relic MCP (`https://mcp.newrelic.com/mcp/`, EU
`https://mcp.eu.newrelic.com/mcp/`) with the bound User API key. No OAuth sign-in, no 24-hour
re-login, and no extra MCP server to configure. They need the same grant as every
`ext__newrelic__*` tool (see [Grant the tools](#grant-the-tools)).

A remote tool is exposed only when all of these hold:

- New Relic annotates it `readOnlyHint: true` and not `destructiveHint: true`. A tool without
  annotations is not exposed.
- It is not OAuth-only. The seed is `natural_language_to_nrql_query` and `search_traces`; a tool
  whose call fails with `requires OAuth` (an HTTP 403 or a tool error saying so) is learned as
  OAuth-only for the life of the extension process. Any other 403 on a call means the MCP is
  unavailable for the key, not that one tool needs OAuth. Each learned tool is logged once
  (`newrelic: mcp tool <name> requires OAuth; hidden`).
- The region's MCP is available for the key.

The catalog is cached per region for 10 minutes, so tools New Relic adds or removes appear or
disappear within 10 minutes, without an extension release.

| Tool | Input | Returns |
| --- | --- | --- |
| `ext__newrelic__mcp_tools` | `region?` (`us` default, or `eu`), `query?` (case-insensitive substring of the name or description), `limit?` (1–60, default 60) | `{region, state, exposed: [{name, description (≤ 200), input: {prop: "type — description (≤ 80)"}}], hidden: {oauth_only, not_read_only}, truncated}`, sorted by name. |
| `ext__newrelic__mcp_call` | `tool`, `arguments?` (object, ≤ 64 KiB as JSON), `region?` | `{tool, is_error, text? (≤ 16 KiB), structured?, truncated}`; `text` is omitted when it only repeats `structured`. |

```json
{"tool": "ext__newrelic__mcp_tools", "input": {"query": "trace"}}
{"tool": "ext__newrelic__mcp_call", "input": {"tool": "list_recent_issues", "arguments": {"account_id": 1234567}}}
```

```json
{"tool": "list_recent_issues", "is_error": false, "text": "{\"issues\": [ ... ]}", "truncated": false}
```

- Arguments are forwarded as given; the remote tool validates them. A remote tool error returns
  `is_error: true` with the remote message in `text`.
- Text content is joined and cut at 16 KiB. `structured` is passed through only when it fits in
  16 KiB. When the text only repeats `structured` as JSON, `text` is left out so a call does not cost
  twice the tokens. Images and other non-text parts become one-line placeholders.
- List tools such as `list_recent_issues` answer `exceeded the 10,000 token limit` without a time
  window: pass `start_time_ms` (epoch milliseconds) or narrower filters.
- Calls time out after 60 s (other requests after 10 s). An expired MCP session is re-initialized
  once; a 404 that persists after that means the MCP is unavailable for the key.
- The key is redacted from every result and error.

Refusals and errors:

Agents see the CompozyOS code with its fixed text, then `Cause:` and `Recovery:` lines. For example:

```text
tool_denied: tool invocation denied
Cause: mcp_tool_not_exposed (oauth_only): natural_language_to_nrql_query requires OAuth; sign in with compozy mcp auth login newrelic or use another tool
Recovery: sign in with compozy mcp auth login newrelic or use another ext__newrelic__mcp_tools tool
```

| Condition | First line | Cause | Recovery |
| --- | --- | --- | --- |
| OAuth-only tool (seeded or learned) | `tool_denied: tool invocation denied` | `mcp_tool_not_exposed (oauth_only): natural_language_to_nrql_query requires OAuth; sign in with compozy mcp auth login newrelic or use another tool` | `sign in with compozy mcp auth login newrelic or use another ext__newrelic__mcp_tools tool` (`newrelic-eu` for `eu`) |
| Tool not marked read-only, or destructive | `tool_denied: tool invocation denied` | `mcp_tool_not_exposed (not_read_only): <tool> is not marked read-only by New Relic; the proxy does not call it` | `call ext__newrelic__mcp_tools to list callable tools` |
| Unknown or removed tool | `tool_denied: tool invocation denied` | `mcp_tool_not_exposed (unknown_tool): <tool> is not in the New Relic MCP catalog for region us` | `call ext__newrelic__mcp_tools to list callable tools` |
| MCP unavailable for the key | `tool_unavailable: tool unavailable` | `mcp_unavailable: New Relic MCP unavailable for this API key (403); use the ext__newrelic__* NerdGraph tools` | `use the ext__newrelic__* NerdGraph tools` |
| Key not bound | `tool_unavailable: tool unavailable` | `credential_absent: …` (same as the other tools; no network call) | `run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` |
| 401 | `tool_unavailable: tool unavailable` | `credential_expired: New Relic rejected the API key; bind a User API key (NRAK-...)` | `bind a User API key (NRAK-...) with compozy extension secrets set …` |
| 429 | `tool_unavailable: tool unavailable` | `rate_limited: New Relic rate limit reached; retry later` | `retry later` |
| Bad `tool`, `arguments` (over 64 KiB) or `limit` | `tool_invalid_input: invalid tool request` | `params_invalid: <what to fix>` | `fix the named parameter and call the tool again` |
| Timeout | `tool_timed_out: tool call timed out` | `mcp_request_failed: no answer within 60s` (10s for other requests) | `retry with a narrower query or time window` |
| 5xx or network error | `tool_backend_failed: tool backend failed` | `mcp_request_failed: <status or error>` | `retry later; if it keeps failing, run compozy extension exec newrelic --cmd doctor` |

A remote tool error is not a tool error: the result has `is_error: true`, and `text` is the remote
message.

Refusals send no request, and an OAuth-only tool is refused even before the catalog loads. When
`initialize` or `tools/list` answers 403 or 404 (or a call gets a 403 without `requires OAuth`) the
region is `unavailable` and is probed again after 10 minutes;
until then both tools answer `mcp_unavailable` at once. After any other probe failure (401, 429,
5xx, network) the call that probed gets the matching error above, and calls in the next minute get
`mcp_unavailable` with the same reason. A catalog whose refresh keeps failing (5xx, network,
timeout) is used for at most 10 more minutes after its last success, then the region is
`unavailable`. A 401 on a warm catalog makes the region `unavailable` too. An `initialize` 403 or
404 when a call renews its session, or a 404 that persists after renewing it, also makes the region
`unavailable`. The doctor and the startup probe share this state and
override any cached catalog: if the doctor reports `unavailable`, the next proxy call answers at
once without a request. Each region
state change seen by the proxy writes one line
(`newrelic: region=us mcp=available|unavailable(<status>)|unknown`) to
`compozy extension logs newrelic`. Arguments and results are never logged.

## Official MCP via OAuth

The [proxy](#official-mcp-via-the-api-key-proxy) covers every tool that works with the API key. Sign
in with OAuth only if agents need the OAuth-only tools, once per scope, when the doctor reports
`MCP: available`:

```bash
compozy mcp auth login newrelic --owner extension:newrelic
```

The extension declares only the US server. EU accounts declare `newrelic-eu` in
`~/.compozy/config.toml` with the same public client, then sign in to it:

```toml
[[mcp_servers]]
name = "newrelic-eu"
transport = "http"
url = "https://mcp.eu.newrelic.com/mcp/"
auth = { registration = "pre_registered", issuer_url = "https://oauth2.service.newrelic.com", client_id = "pUWGgnjsQ0bydqCbavTPpw==", scopes = ["observability:read", "offline_access"] }
```

```bash
compozy mcp auth login newrelic-eu --scope user
```

Use the scope where you installed the extension: the default `--scope user` matches a global
install; for a workspace install add `--scope workspace --workspace my-project`. After a
successful login the server's tools become callable for sessions in that scope, even with
`tools.policy.external_default = "disabled"`. `compozy mcp auth logout` withdraws them.

What New Relic requires:

- A **paid** plan. Free accounts cannot use the MCP.
- An organization role of **Organization Read Only**, **Organization Manager** or **Product Admin**.
- The admin setting **New Relic MCP Server** turned on. It is on by default.
- Access tokens last 5 minutes and refresh automatically. New Relic asks you to sign in again after
  24 hours, which is why unattended agents should rely on the proxy.

Redirect: CompozyOS's default callback (`http://127.0.0.1:2123/api/mcp/oauth/callback`) works.
New Relic accepts only pre-registered redirect paths, so if you changed `mcp.oauth.redirect_uri` to
another path, the sign-in is rejected (`redirect_uri ... does not match any of the OAuth 2.0
Client's pre-registered redirect urls`).

The servers use New Relic's published public client (PKCE, no secret) with scopes
`observability:read offline_access`. The API key is never sent to the OAuth servers; only the proxy
and the doctor's probe send it, in the `api-key` header.

## Migrating from a manual `newrelicapi` MCP

If you configured the New Relic MCP by hand with an API-key header (often named `newrelicapi`), the
proxy replaces it: every tool you used through it, except the OAuth-only ones, is reachable through
`ext__newrelic__mcp_call`.

1. Install or update this extension, bind the key and grant the tools (sections above).
2. Run the doctor. It should report `MCP: available (N tools exposed via API key; …)`.
3. Remove the manual server from your user `config.toml` and drop its trusted source, keeping
   `"extension:newrelic"`:

   ```diff
   -[[mcp_servers]]
   -name = "newrelicapi"
   -command = "node"
   -args = ["<path>/mcp-remote/dist/proxy.js", "https://mcp.newrelic.com/mcp/", "--transport", "http-only", "--header", "Api-Key:${NEW_RELIC_API_KEY}"]
   -secret_env = { NEW_RELIC_API_KEY = "<your vault ref>" }
    [tools.policy]
   -trusted_sources = ["mcp:newrelicapi", "extension:newrelic"]
   +trusted_sources = ["extension:newrelic"]
   ```

   Then restart the daemon (`compozy daemon stop && compozy daemon start`).
4. Update agent instructions that name `newrelicapi` tools: call `ext__newrelic__mcp_tools` to find a
   tool and `ext__newrelic__mcp_call` to run it.
5. Verify: run the doctor again, then have an agent call `ext__newrelic__mcp_tools`. It should return
   `state: "available"` and the tools you used before.

OAuth-only tools (such as `natural_language_to_nrql_query`) stay reachable only through the OAuth
servers `newrelic` and, for EU, `newrelic-eu` (see [Official MCP via OAuth](#official-mcp-via-oauth)). The
manual server and the extension keep separate secrets, so they can coexist while you migrate.

## Cost model

- **Source checks cost zero model tokens.** Each check is a fixed NRQL or GraphQL query built from
  the source parameters. It never calls an LLM, a New Relic AI feature or an MCP server. Identical
  inputs give identical results.
- **Only new items wake the agent.** A check with nothing new returns no items, and the daemon skips
  the model turn.
- **Tools cost tokens only when the woken agent uses them.** Tool output is compact and bounded.
- **The MCP proxy adds two small, static tool schemas.** The remote catalog is never part of the
  agent's context up front: its schemas are loaded on demand, only when an agent calls
  `ext__newrelic__mcp_tools`, and that answer is capped at 60 compact rows.
- New Relic counts each query against your NRQL and NerdGraph usage. Pick `min_interval` with that in
  mind.

## Limitations

- **Issues window and filters** (spec deviations D-4, D-6). `newrelic/issues` and `alert_issues`
  use NerdGraph's default issue window of the last 24 hours. An issue that stays open longer than
  that leaves the active set silently; if it re-enters the window, it is reported again. There is no
  alert-policy filter (`policy_ids`), because issues carry no policy; scope with `entity_guids` and
  `priorities`. Issues carry no condition name, and item links point to the New Relic UI home, not
  to the issue.
- **Errors count events, not Errors Inbox groups.** `newrelic/errors` counts `TransactionError` (and
  optionally `JavaScriptError`) events per normalized type. Errors Inbox may group them differently,
  and the item summary has no "first seen" time (D-5).
- **`JavaScriptError` facets are unverified** (D-5). If those events expose only
  `errorClass`/`errorMessage` instead of `error.class`/`error.message`, their class and message read
  as `null`.
- **No JP region.** Only `us` and `eu`.
- **Cross-account `recent_logs` lines do not name their account.** Query one account at a time
  when that matters, or use `nrql_query` with `FACET accountId()`.
- **All accounts of a cross-account query share one region.** NerdGraph serves one region per
  request.
- The `aiIssues` field names follow New Relic's public docs and still need a check against a real
  account (D-4).

### Corporate TLS inspection

CompozyOS starts extensions without your shell's `NODE_EXTRA_CA_CERTS`, so the extension trusts the
operating system CA store itself (Node.js 22.19+ or 24.5+). If your company re-signs New Relic traffic
(Netskope, Zscaler), install its CA in the OS store (`/usr/local/share/ca-certificates` plus
`update-ca-certificates` on Debian/Ubuntu, the System keychain on macOS). An untrusted CA shows as
`New Relic request failed: TLS certificate not trusted (SELF_SIGNED_CERT_IN_CHAIN); install the
network's CA in the operating system store`.

## Security notes

- The API key lives in the CompozyOS secret store and travels only in the NerdGraph request header
  and in the `api-key` header to the region's official MCP host (proxy and doctor). It never appears
  in items, tool results, error messages, logs or source state; key text that New Relic echoes back
  (results, tool names, descriptions, schemas) is redacted before anything is shortened.
- Redirects are never followed: a 3xx from NerdGraph or the MCP host fails the request, so the key
  is never resent to another host.
- The extension is read-only: it sends no NerdGraph mutations, and the proxy calls only remote tools
  New Relic marks read-only and not destructive. The check-in sources never touch the MCP.
- No Host API permissions are requested.

## Development

```bash
bun install
bun run typecheck
bun test
mise exec node@22 -- npm run test:node   # the same tests under Node 22
bun run build                            # tsc + dist/index.js
bun run package                          # dist/release: the installable, publishable artifact
```

`bun run package` runs `compozy extension build`, copies the generation to `dist/release`, appends
the OAuth MCP server tables to its `extension.toml`, and validates it (spec deviation D-8). Install
and publish `dist/release`, never a bare `dist/gen-*`, which has no MCP servers. Every build clears
`dist/release`.

Tests use in-process fakes for NerdGraph and the MCP; they never call New Relic. For a local
end-to-end run against a daemon, start the fake and use its loopback region, a testing aid that is
not meant for real use (D-1):

```bash
node test/fake-nerdgraph.ts --port 8788
curl -X POST http://127.0.0.1:8788/_fake/rows -d '[{"facet":"checkout-api","p95":2.31}]'
# in HEARTBEAT.md: with: { account_id: 1234567, region: "loopback:8788", ... }; any NRAK-... key works
```

The same fake serves a fake official MCP at `POST /mcp/` (JSON answers, or SSE with `--sse`), so
`region: "loopback:8788"` also works for `mcp_tools`, `mcp_call` and the doctor. Its default
catalog mixes read-only, OAuth-only, destructive and unannotated tools. `/_fake/mcp` reads and
changes its settings:

```bash
node test/fake-nerdgraph.ts --port 8788 --sse
curl http://127.0.0.1:8788/_fake/mcp                                   # mode, statuses, tool names
curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"initStatus":403}'    # MCP unavailable for the key
curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"expireCalls":1}'     # next call finds its session expired
curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"holdOpen":true}'     # SSE answers keep the stream open
curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"reset":true}'        # default catalog and settings
```

### Releasing

1. Bump the version in `package.json` and `EXTENSION_VERSION` in `src/index.ts`.
2. `bun run typecheck && bun test && mise exec node@22 -- npm run test:node`.
3. Package and publish (needs `GITHUB_TOKEN` with repo scope):

   ```bash
   bun run package
   compozy extension publish ./dist/release --repository jillesmc/compozy-newrelic --tag vX.Y.Z
   ```

## Compatibility

This extension is experimental and versioned 0.x. Within 0.x:

- Parameter names and meanings stay stable. A rename keeps the old key accepted for one minor release,
  with a deprecation note in the release notes. Exception: 0.4.0 removes `NEW_RELIC_APP` without a
  window (see [Migrating from 0.3.x](#migrating-from-03x)).
- A change to the stored state shape makes the next check re-baseline quietly. You lose at most one
  check's worth of "new" signal and are never flooded.

Supported: CompozyOS 0.7.0 or newer, New Relic US and EU regions.

## License

[MIT](LICENSE)
