# Developer Experience: New Relic check-in sources and investigation tools

Public-surface contract for the `newrelic` extension. Companion to `_spec.md` and `_tests.md`. Every
CompozyOS command shown already exists; the extension adds four source kinds, six tools, one operator
command, two OAuth MCP servers, one secret, and the errors below.

## Golden Path

```bash
# 1. Install (Node.js 22+)
compozy extension install github:jillesmc/compozy-newrelic@v0.1.0 --allow-unverified --yes

# 2. Bind a New Relic User API key (NRAK-...): one.newrelic.com → user menu → API keys
compozy extension secrets set newrelic --env NEW_RELIC_API_KEY
compozy extension disable newrelic && compozy extension enable newrelic

# 3. Grant the extension's read-only tools (Deviation D-10): add to the user config.toml
#    (path: compozy config path --scope user), then restart the daemon
#      [tools.policy]
#      trusted_sources = ["extension:newrelic"]
compozy daemon stop && compozy daemon start

# 4. Check what this account can use
compozy extension exec newrelic --cmd doctor --region us
```

Without step 3 every `ext__newrelic__*` tool, the doctor included, fails with `tool_denied`
(`source_disabled`), because `tools.policy.external_default` defaults to `disabled`. Sources work
without it. `compozy config set` cannot write `tools.policy` (trust root), so edit the file.

```text
NerdGraph: ok (region us, 21 accounts visible)
MCP: available — run `compozy mcp auth login newrelic` to give agents the official New Relic tools
```

On a free account or without the MCP admin toggle:

```text
NerdGraph: ok (region us, 1 account visible)
MCP: unavailable (403 from https://mcp.newrelic.com/mcp/) — agents keep the ext__newrelic__* tools; skip the MCP login
```

Add sources to an always-on agent's `HEARTBEAT.md` (YAML below), save it, then:

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

Later, when p95 crosses the threshold:

```text
Would run: yes
Sources:
  checkout-p95  newrelic/nrql  ok  1 item  (702 ms)
Digest:
  source:checkout-p95:checkout-api  checkout-api above 1.5: 2.31 (p95 duration, account 1234567)
```

## YAML

`HEARTBEAT.md` of an always-on agent (managed authoring or the Heartbeat page):

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

Parameters (all kinds accept `account_id` (required, integer), `region` (`us` | `eu`, default `us`),
`notify_existing` (bool, default `false`)):

| Kind | Key | Type | Default | Effect |
| --- | --- | --- | --- | --- |
| `newrelic/nrql` | `nrql` | string | — (required) | Any NRQL returning one number per row (optionally `FACET`). |
| | `condition` | `above` \| `below` | `above` | Breach direction. |
| | `threshold` | number | — (required) | Breach boundary (strict `>` / `<`). |
| `newrelic/issues` | `priorities` | string[] | `[CRITICAL, HIGH]` | Issue priorities that count. |
| | `entity_guids` | string[] | none | Only issues on these entities. (No `policy_ids`: issues carry no policy; Deviation D-S2-a.) |
| `newrelic/errors` | `where` | string | none | NRQL `WHERE` body (no `WHERE` keyword). |
| | `event_types` | string[] | `[TransactionError]` | Also `JavaScriptError`. |
| | `window` | duration | `30m` | Counting window (`m`/`h`, 5m–24h). |
| | `min_count` | integer | `1` | Occurrences in the window to count as active. |
| `newrelic/logs` | `where` | string | — (required) | NRQL `WHERE` body over `Log`. |
| | `facet` | string | none | Attribute to group by (e.g. `service.name`). |
| | `window` | duration | `15m` | Counting window. |
| | `threshold` | integer | — (required) | Lines in the window to count as active (strict `>`). |

## CLI and tools

| Surface | Result |
| --- | --- |
| `compozy agent heartbeat sources <agent>` | Lists `newrelic/nrql  NRQL threshold`, `newrelic/issues  New Relic alert issues`, `newrelic/errors  New errors`, `newrelic/logs  Log spikes`. |
| `compozy extension exec newrelic --cmd doctor [--region eu]` | The probe report shown in the Golden Path. |
| `compozy extension logs newrelic` | One startup line: `newrelic: probe region=us nerdgraph=ok mcp=available`. |
| `compozy mcp auth login newrelic` / `newrelic-eu` | Official MCP via OAuth (paid accounts with MCP enabled). |

Tools (read-only, model-visible, compact; all take `account_id` where relevant and `region`):

| Tool ID | Input | Returns |
| --- | --- | --- |
| `ext__newrelic__nrql_query` | `nrql`, `account_id`, `region?` | Up to 50 rows as a compact table, plus `truncated`. |
| `ext__newrelic__list_accounts` | `region?` | `[{id, name}]`. |
| `ext__newrelic__search_entities` | `query` (name or NerdGraph entity search), `region?` | Up to 25 `{guid, name, type, domain, alert_severity}`. |
| `ext__newrelic__alert_issues` | `account_id`, `state?` (`open` default), `priorities?`, `since?` | Up to 25 issues `{id, title, priority, state, entities, opened_at, url}` (no condition: Deviation D-6). |
| `ext__newrelic__error_groups` | `account_id`, `where?`, `window?` | Up to 25 `{app, class, message (≤160), count, last_seen}`. |
| `ext__newrelic__recent_logs` | `account_id`, `where`, `window?`, `limit?` (≤50) | Lines `{timestamp, service, level, message (≤300)}`. |
| `ext__newrelic__doctor` | `region?` | The probe report (operator command; agents should not call it). |

Item example (`newrelic/errors`):

```json
{
  "key": "checkout-api/TimeoutError/7f3a91c2",
  "title": "TimeoutError in checkout-api: 37 in 30m",
  "summary": "New error type · account 1234567 (us) · first in window 14:02 UTC · message: Upstream timed out after # ms calling #",
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

## Errors

| Condition | Code | Message |
| --- | --- | --- |
| `NEW_RELIC_API_KEY` not bound | `source_credential_absent` | `New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY` |
| Key rejected (401/403 auth, or not an `NRAK-` user key) | `source_credential_expired` | `New Relic rejected the API key; bind a User API key (NRAK-...)` |
| 429 | `source_rate_limited` | `New Relic rate limit reached; retry later` |
| NRQL/GraphQL error | `source_params_invalid` | `New Relic rejected the query: <message ≤ 300 chars>` |
| No access to `account_id` | `source_params_invalid` | `this API key cannot read account 1234567` |
| Result shape not numeric | `source_params_invalid` | `nrql must return one number per row (e.g. SELECT count(*) ... FACET x)` |
| More than 500 rows | `source_params_invalid` | `nrql returned more than 500 rows; add LIMIT or narrow the FACET` |
| Active set over `max_state_bytes` | `source_params_invalid` | `<n> active signals do not fit max_state_bytes=16384; narrow the source` |
| 5xx, network error, request timeout (10 s) | `source_extension_failed` | `New Relic request failed: <status or error>` |
| Tool without key | tool error `credential_absent` | same text as the source error |
