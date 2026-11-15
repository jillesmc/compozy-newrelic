# compozy-newrelic

> **Experimental (0.x).** See [Compatibility](#compatibility).

A [CompozyOS](https://github.com/compozy/compozy) extension named `newrelic`. It does three things:

- **Four check-in sources** wake an always-on agent only when New Relic shows something new:
  `newrelic/nrql` (metric threshold), `newrelic/issues` (alert issues), `newrelic/errors` (new error
  types) and `newrelic/logs` (log spikes). A quiet check costs no model turn.
- **Six read-only investigation tools** (`ext__newrelic__*`) backed by NerdGraph. They work with a
  User API key on every plan, free included.
- **The official New Relic MCP, OAuth only** (`newrelic` and `newrelic-eu`). Its tools reach agents
  only after a successful OAuth sign-in on an account that can use them.

A `doctor` command tells you, without spending agent tokens, whether your account can use the
official MCP. The extension never writes to New Relic.

## Requirements

- CompozyOS 0.7.0 or newer. Older daemons refuse the install with a version error.
- Node.js 22 or newer on the daemon's `PATH`. The extension is one JavaScript file run by `node`.
- Linux or macOS.
- A New Relic **User API key** (`NRAK-…`). License and ingest keys do not work.

## Install

Run this from your project directory (a CompozyOS workspace):

```bash
compozy extension install github:jillesmc/compozy-newrelic@v0.1.0 --allow-unverified --yes
```

The consent flags are required: GitHub installs are not catalog-verified, so CompozyOS refuses them
with `extension_checksum_unverified` unless you pass `--allow-unverified` (`--yes` skips the prompt).
The release's `.sha256` sidecar is still checked for integrity, and `--expected-digest <sha256>` pins
the exact archive you reviewed.

The official MCP servers default to workspace scope, so the install needs a workspace. From
outside a workspace directory, add `--workspace <id|name|path>` or choose `--scope global`.

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

This one secret serves every source and tool. The official MCP does not use it; it signs in with
OAuth (see [Official MCP via OAuth](#official-mcp-via-oauth)).

## Grant the tools

On a default daemon every `ext__newrelic__*` tool, including the doctor, is denied with
`tool_denied` (`source_disabled`). That is because `tools.policy.external_default` defaults to
`disabled`. The check-in sources work without this step; the tools and the doctor need it.

All tools are read-only, so you can mark the extension as a trusted read-only source. Add this to
your user `config.toml` (`compozy config path --scope user` prints its path):

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
MCP: available — run `compozy mcp auth login newrelic` to give agents the official New Relic tools
```

On a free account, or when the MCP admin toggle is off:

```text
NerdGraph: ok (region us, 1 account visible)
MCP: unavailable (403 from https://mcp.newrelic.com/mcp/) — agents keep the ext__newrelic__* tools; skip the MCP login
```

`MCP: unknown (<reason>)` means the probe could not decide (network error or timeout). Run it again
later. The doctor never fails because of the MCP, and it makes no network call when no key is bound.
It probes the MCP with `initialize` only and never calls an MCP tool.

The same probe runs once when the extension starts and writes one line to
`compozy extension logs newrelic`:

```text
newrelic: probe region=us nerdgraph=ok mcp=available
```

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

For each New Relic item, investigate with the ext__newrelic__* tools (and the newrelic MCP tools if
available). Propose "Investigate <key>" with a one-paragraph hypothesis. Stay quiet when it recovers.
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
| `account_id` | integer | required | New Relic account to query. |
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
- The value is the first numeric field of each row that is not the facet; `percentile(x, 95)` reads
  as `p95 x`. A null value (no data) never breaches.
- More than 500 rows fail with `source_params_invalid`; add `LIMIT` or narrow the `FACET`.
- Item: `checkout-api above 1.5: 2.31 (p95 duration, account 1234567)`.

### `newrelic/issues` — New Relic alert issues

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `priorities` | string[] (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) | `[CRITICAL, HIGH]` | Issue priorities that count. |
| `entity_guids` | string[] | none | Only issues on these entities. |

- Active: state `ACTIVATED` or `CREATED`, with a listed priority. Key: the issue id.
- Order: CRITICAL > HIGH > MEDIUM > LOW, then oldest first.
- Item: `CRITICAL issue: <incident titles>`, with priority, state, entities and activation time.
- There is no `policy_ids` filter; see [Limitations](#limitations).

### `newrelic/errors` — New errors

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `where` | string | none | NRQL `WHERE` body, without the `WHERE` keyword. |
| `event_types` | string[] (`TransactionError`, `JavaScriptError`) | `[TransactionError]` | Event types to count. |
| `window` | duration | `30m` | Counting window. |
| `min_count` | integer ≥ 1 | `1` | Occurrences in the window that make an error type active. |

- An error type is app + `error.class` + normalized `error.message`. Digit runs, hex ids of 8 or more
  characters, UUIDs and quoted strings collapse to `#`, so `Order 123 not found` and
  `Order 456 not found` are one type.
- Key: `app/class/<8 hex of the normalized message hash>`.
- Item: `TimeoutError in checkout-api: 37 in 30m`. It carries at most 160 characters of the
  normalized message and never a stack trace.

### `newrelic/logs` — Log spikes

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `where` | string | required | NRQL `WHERE` body over `Log`. |
| `facet` | string | none | Attribute to group by (for example `service.name`). |
| `window` | duration | `15m` | Counting window. |
| `threshold` | integer ≥ 0 | required | Lines in the window that make a group active (strict `>`). |

- Key: the facet value, or `all` without `facet`. A facet that does not exist returns no rows, so
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

Each poll runs one NRQL query (`newrelic/nrql`, `errors`, `logs`) or one to 20 issue pages.
A `min_interval` of 5 minutes or more is a sensible floor.

### Errors

| Condition | Code | Message |
| --- | --- | --- |
| `NEW_RELIC_API_KEY` not bound | `source_credential_absent` | `New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` |
| Key rejected (401/403), or not an `NRAK-` user key | `source_credential_expired` | `New Relic rejected the API key; bind a User API key (NRAK-...)` |
| 429 | `source_rate_limited` | `New Relic rate limit reached; retry later` |
| NRQL or GraphQL error | `source_params_invalid` | `New Relic rejected the query: <message, at most 300 characters>` |
| No access to `account_id` | `source_params_invalid` | `this API key cannot read account 1234567` |
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
nrql: "SELECT (filter(count(*), WHERE duration <= 0.5) + filter(count(*), WHERE duration > 0.5 AND duration <= 2) / 2) / count(*) FROM Transaction FACET appName SINCE 15 minutes ago LIMIT 100"
condition: below
threshold: 0.85
```

This spells out the Apdex formula on purpose. NRQL's `apdex()` returns an object with several
numbers (`s`, `t`, `f`, the score), and the source reads the first number it finds, which may not
be the score.

**Infrastructure CPU per host (%), above 90:**

```yaml
nrql: "SELECT average(cpuPercent) FROM SystemSample FACET hostname SINCE 10 minutes ago LIMIT 200"
condition: above
threshold: 90
```

Leave a margin between the threshold and normal values. A value that hovers around the threshold
wakes the agent on every re-entry.

## Tools reference

All tools are read-only and compact: at most 50 rows (25 for entities, issues and error groups) and
8 KiB of text, with `truncated` set when something was cut. Every tool accepts `region` (`us`
default, or `eu`).

| Tool | Input | Returns |
| --- | --- | --- |
| `ext__newrelic__nrql_query` | `account_id`, `nrql` | Up to 50 rows as a compact table. |
| `ext__newrelic__list_accounts` | — | Up to 50 `{id, name}`. |
| `ext__newrelic__search_entities` | `query` (a name, or a NerdGraph entity search such as `domain = 'APM' AND name LIKE 'checkout'`) | Up to 25 `{guid, name, type, domain, alert_severity}`. |
| `ext__newrelic__alert_issues` | `account_id`, `state?` (`open` default, `closed`, `all`), `priorities?`, `since?` (≤ `24h`) | Up to 25 `{id, title, priority, state, entities, opened_at, url}`, highest priority and newest first. |
| `ext__newrelic__error_groups` | `account_id`, `where?`, `window?` (`30m` default) | Up to 25 `{app, class, message (≤ 160), count, last_seen}`, most frequent first. |
| `ext__newrelic__recent_logs` | `account_id`, `where`, `window?` (`15m` default), `limit?` (1–50, default 20) | Lines `{timestamp, service, level, message (≤ 300)}`. |
| `ext__newrelic__doctor` | — | The doctor report. It is an operator command; its description tells agents not to call it. |

Without a bound key, the investigation tools return a `credential_absent` error that names the
secrets command, and they make no network call.

## Plan matrix

| Capability | Free plan | Paid plan | Credential |
| --- | --- | --- | --- |
| Check-in sources (`newrelic/*`) | yes | yes | User API key |
| Investigation tools (`ext__newrelic__*`) | yes | yes | User API key |
| Doctor | yes | yes | User API key |
| Official MCP (`newrelic`, `newrelic-eu`) | no | yes, with the role and admin toggle below | OAuth sign-in |
| OAuth-only MCP tools (for example `natural_language_to_nrql_query`) | no | yes | OAuth sign-in |
| Official MCP with an API key | not offered | not offered | — |

The extension never offers the official MCP with an API key. With an API key, New Relic lists the
OAuth-only tools but rejects calls to them with 403, so agents would spend tokens on tools that cannot
work.

## Official MCP via OAuth

Sign in once per scope when the doctor reports `MCP: available`:

```bash
compozy mcp auth login newrelic --owner extension:newrelic --scope workspace --workspace my-project
# EU accounts:
compozy mcp auth login newrelic-eu --owner extension:newrelic --scope workspace --workspace my-project
```

Use the scope where you installed the extension (`--scope user` for a global install). After a
successful login the server's tools become callable for sessions in that scope, even with
`tools.policy.external_default = "disabled"`. `compozy mcp auth logout` withdraws them.

What New Relic requires:

- A **paid** plan. Free accounts cannot use the MCP.
- An organization role of **Organization Read Only**, **Organization Manager** or **Product Admin**.
- The admin setting **New Relic MCP Server** turned on. It is on by default.
- Access tokens last 5 minutes and refresh automatically. New Relic asks you to sign in again after
  24 hours.

Redirect: CompozyOS's default callback (`http://127.0.0.1:2123/api/mcp/oauth/callback`) works.
New Relic accepts only pre-registered redirect paths, so if you changed `mcp.oauth.redirect_uri` to
another path, the sign-in is rejected (`redirect_uri ... does not match any of the OAuth 2.0
Client's pre-registered redirect urls`).

The servers use New Relic's published public client (PKCE, no secret) with scopes
`observability:read offline_access`. The API key is never sent to the MCP for tool use. The doctor's
probe sends it only to an `initialize` request.

## Replacing a manual `newrelicapi` MCP

If you configured the New Relic MCP by hand with an API key header (often named `newrelicapi`), its
OAuth-only tools fail with 403 and agents waste turns on them. To replace it:

1. Install this extension, bind the key and run the doctor.
2. If the doctor reports `MCP: available`, sign in with `compozy mcp auth login newrelic` as above.
3. Remove the manual server from **Settings → MCP servers**, or delete its `[mcp_servers.newrelicapi]`
   table from your `config.toml`.
4. Update agent instructions that name `newrelicapi` tools: use the `newrelic` MCP tools and the
   `ext__newrelic__*` tools instead.

The manual server and the extension's server keep separate credentials, so they can coexist while
you migrate.

## Cost model

- **Source checks cost zero model tokens.** Each check is a fixed NRQL or GraphQL query built from
  the source parameters. It never calls an LLM, a New Relic AI feature or an MCP server. Identical
  inputs give identical results.
- **Only new items wake the agent.** A check with nothing new returns no items, and the daemon skips
  the model turn.
- **Tools cost tokens only when the woken agent uses them.** Tool output is compact and bounded.
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
- The `aiIssues` field names follow New Relic's public docs and still need a check against a real
  account (D-4).

## Security notes

- The API key lives in the CompozyOS secret store and travels only in the NerdGraph request header
  (and the doctor's MCP probe). It never appears in items, tool results, error messages, logs or
  source state; key text that New Relic echoes back is redacted before anything is shortened.
- The extension is read-only: it sends no NerdGraph mutations and never calls an MCP tool.
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
  with a deprecation note in the release notes.
- A change to the stored state shape makes the next check re-baseline quietly. You lose at most one
  check's worth of "new" signal and are never flooded.

Supported: CompozyOS 0.7.0 or newer, New Relic US and EU regions.

## License

[MIT](LICENSE)
