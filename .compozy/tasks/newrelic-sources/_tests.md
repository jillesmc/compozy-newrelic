# Test Specification: New Relic check-in sources and investigation tools

Canonical test contract. Companion to `_spec.md`; derived from `_user_stories.md` and `_dx.md`.

## Strategy

- `bun test`, also run under Node 22 in CI. A fake NerdGraph (in-process `node:http`) returns recorded
  response shapes: NRQL results with and without facets, `aiIssues` pages, GraphQL `errors`, and
  401/403/429/503. A fake MCP endpoint serves the doctor probe. The clock is injected; fakes sit only
  at the network boundary.
- Test names carry their IDs, e.g. `UT-010 engine: still-active key is not returned again`.
- E2E-001 and E2E-002 run against the local CompozyOS daemon with the fakes. E2E-003 and E2E-004 are
  operator-run against a real New Relic account. E2E-005 runs after publish.

## Coverage Matrix

| Source | Behavior | Unit | Integration | E2E |
| --- | --- | --- | --- | --- |
| US-001.AC-1/2/3 | Breach, stays, recover, re-breach | UT-010, UT-011, UT-012 | IT-001 | E2E-002 |
| US-001.AC-4 | Faceted independence | UT-013 | IT-001 | — |
| US-001.AC-5 | `below` | UT-014 | — | — |
| US-001.EC-1 | Invalid NRQL | — | IT-004 | — |
| US-001.EC-2 | Non-numeric shape | UT-030 | — | — |
| US-001.EC-3 | > 500 rows | UT-031 | — | — |
| US-001.EC-4 | Null value inactive | UT-032 | — | — |
| US-001.EC-5 | NRQL timeout | — | IT-009 | — |
| US-002.* | Issues filter, open, close, reopen, capacity | UT-040–UT-043 | IT-002 | E2E-003 |
| US-003.* | Errors window, normalization, event types, min_count | UT-050–UT-054 | IT-003 | E2E-003 |
| US-004.* | Logs threshold, facet optional, no raw lines | UT-060–UT-062 | IT-003 | E2E-003 |
| US-005.* | Quiet baseline, notify_existing, fingerprint change | UT-015–UT-017 | — | E2E-002 |
| US-006.* | Item bounds, no key leak | UT-070, UT-071 | IT-005 | — |
| US-007.AC-1/3, EC-2 | Secret, errors | UT-080 | IT-005–IT-008 | E2E-002 |
| US-007.AC-2 | Region endpoints | UT-081 | IT-010 | — |
| US-007.EC-1 | No account access | — | IT-011 | — |
| US-008.* | Tools work, bounded, no key → error | UT-090–UT-095 | IT-012 | E2E-002 |
| US-009.* | OAuth MCP gating | — | — | E2E-004 |
| US-010.* | Doctor command and startup line | UT-100–UT-102 | IT-013 | E2E-002 |
| US-011.* | Install a release | UT-110 (manifest) | — | E2E-005 |
| BR-12 | Deterministic, model-free sources | UT-120–UT-123 | — | — |

## Unit Tests

### engine (Spec: Business Rules 1, 5–7)

- **UT-010** (happy): committed `active:[]` (non-baseline), signals `[a]` → 1 item `a`; state `active:[a]`.
- **UT-011** (idempotency): committed `[a]`, signals `[a]` → 0 items; state `[a]`.
- **UT-012** (state): committed `[a]`, signals `[]` → state `[]`. Next poll with signals `[a]` → 1 item.
- **UT-013** (state): committed `[x]`, signals `[x, y]` → item `y` only.
- **UT-014** (happy): nrql kind with `below 100`, a row value of 80 is active and 120 is inactive.
- **UT-015** (state): no state, signals `[a, b]`, `notify_existing:false` → 0 items; state `[a, b]` with fingerprint.
- **UT-016** (state): no state, `notify_existing:true` → 2 items.
- **UT-017** (state): fingerprint mismatch → baseline behavior. Changing only `notify_existing` keeps the fingerprint.
- **UT-018** (boundary): 25 new signals, `max_items` 20 → 20 items by rank, `more:true`, 5 not committed; next poll → 5 items.
- **UT-019** (boundary): an active set that does not fit `max_state_bytes` → `source_params_invalid` with count and limit; no result.

### nrql kind

- **UT-030** (error): rows without a numeric non-facet field → `source_params_invalid` with the shape message.
- **UT-031** (boundary): 501 rows → `source_params_invalid` with the LIMIT message; 500 rows are accepted.
- **UT-032** (boundary): a null value → inactive.
- **UT-033** (happy): facet arrays `["checkout-api","prod"]` → key `checkout-api/prod`; no facet → `_`.

### issues kind

- **UT-040** (happy): with `priorities [CRITICAL,HIGH]`, a LOW issue gives no signal and a CRITICAL issue gives a signal keyed by `issueId`.
- **UT-041** (ordering): CRITICAL ranks before HIGH, then older activation first.
- **UT-042** (state): an issue absent from the open list (closed) drops from state; the same id open again → item.
- **UT-043** (happy): the `entity_guids` and `policy_ids` filters are passed into the query variables.

### errors kind and normalize

- **UT-050** (happy): `Order 123 not found` and `Order 456 not found` normalize to `Order # not found`, and their counts are summed.
- **UT-051** (happy): UUIDs, hex ≥ 8 characters, and quoted strings collapse to `#`; the result is truncated to 160 characters.
- **UT-052** (boundary): `min_count 10`: 9 is inactive and 10 is active.
- **UT-053** (happy): `event_types [TransactionError, JavaScriptError]` appear in the NRQL `FROM` clause.
- **UT-054** (happy): the key is `app/class/<8 hex>` and is sanitized to the daemon alphabet.

### logs kind

- **UT-060** (boundary): `threshold 50`: 50 is inactive and 51 is active.
- **UT-061** (happy): no facet → single key `_`; the NRQL has no FACET clause.
- **UT-062** (happy): the item summary and attributes contain no field named `message` or raw line content.

### items and keys

- **UT-070** (boundary): the title is ≤ 200 characters, the summary ≤ 1 KiB, the attributes ≤ 2 KiB (they shrink by dropping `nrql` first), and keys are ≤ 200 bytes with the hash suffix rule.
- **UT-071** (error): an API key value injected into a facet value or error message never appears in the item (redaction, compozy-jira R-7/R-8 lesson).

### credentials and region

- **UT-080** (error): no key → `source_credential_absent` with the secrets command; a key not starting with `NRAK-` → `source_credential_expired` with the User key hint, and no network call.
- **UT-081** (happy): `us` resolves to `https://api.newrelic.com/graphql`, `eu` to `https://api.eu.newrelic.com/graphql`, and the MCP probe URLs likewise.

### tools

- **UT-090** to **UT-095** (happy and boundary), one per tool: `nrql_query`, `list_accounts`, `search_entities`, `alert_issues`, `error_groups`, `recent_logs`. Each returns compact output with at most its row cap and ≤ 8 KiB, with `truncated` set when it cut. `recent_logs` messages are ≤ 300 characters.

### doctor

- **UT-100** (happy): NerdGraph ok with 21 accounts and MCP 200 with tools capability → `MCP: available` plus the login hint.
- **UT-101** (error): MCP 403 → `MCP: unavailable (403 …)` plus the "keep ext tools" hint.
- **UT-102** (error): MCP network error → `MCP: unknown (<error>)`; the doctor still exits successfully.

### determinism (Spec: Business Rule 12; owned by S1, S2 reuses UT-121 for its kinds)

- **UT-120** (idempotency): the same request twice → deep-equal and byte-equal JSON results.
- **UT-121** (determinism): shuffled NerdGraph row order → identical result (S1: nrql; S2: errors, logs, issues).
- **UT-122** (state): unchanged active set → encoded state byte-identical to the committed state, and zero items.
- **UT-123** (static): no code path under `src/sources` or `src/engine` imports or calls the MCP client, the doctor MCP probe, or any AI endpoint.

### manifest

- **UT-110** (happy): the generated `extension.toml` has `min_compozy_version = "0.7.0"`, `requires_env = ["NEW_RELIC_API_KEY"]`, provides `heartbeat.source` and `tool.provider`, has 4 source kinds and 7 tools, a `doctor` command block, and OAuth MCP servers `newrelic` and `newrelic-eu`.

## Integration Tests (fake NerdGraph / fake MCP)

- **IT-001**: the nrql source across three polls (below, above, above) returns items 0, 1, 0, and the request carries `API-Key` and the NRQL variable.
- **IT-002**: issues source pagination with `nextCursor` across 2 pages merges the results.
- **IT-003**: the errors and logs sources build the expected NRQL text (`SINCE 30 minutes ago`, `LIMIT 500`).
- **IT-004**: HTTP 200 with `errors:[{message:"NRQL Syntax error…"}]` → `source_params_invalid` with the message ≤ 300 characters.
- **IT-005**: 401 → `source_credential_expired`, and the message never contains the key.
- **IT-006**: 403 with an auth error → `source_credential_expired`.
- **IT-007**: 429 → `source_rate_limited`.
- **IT-008**: 503 → `source_extension_failed`.
- **IT-009**: no response for 11 s → per-request timeout → `source_extension_failed`.
- **IT-010**: `region: eu` sends requests to the EU path of the fake (host routing).
- **IT-011**: GraphQL `errors` naming account access → `source_params_invalid`, `this API key cannot read account 1234567`.
- **IT-012**: each tool against the fake returns its documented compact shape.
- **IT-013**: the startup probe writes exactly one stderr line with `nerdgraph=` and `mcp=`, and never the key.

## End-to-End Tests

- **E2E-001**: `bun run build`, then `compozy extension build`, then `compozy extension validate` → valid, no error issues; consent areas listed and justified.
- **E2E-002** (local daemon, fakes):
  1. Install locally and bind a fake key.
  2. `compozy agent heartbeat sources` (native tool) lists the 4 kinds.
  3. Dry run of a 4-source HEARTBEAT shows a quiet baseline.
  4. Push the fake p95 above the threshold → the dry run shows one `newrelic/nrql` item.
  5. `compozy extension exec newrelic --cmd doctor` prints the report.
  6. Invoke `ext__newrelic__nrql_query` → a compact table.
  7. Remove all test state afterwards.
- **E2E-003** (operator-run, real account): the issues, errors, and logs sources against a real account, with a deliberately low threshold to observe one item each. Record the real `aiIssues` field names.
- **E2E-004** (operator-run): `compozy mcp auth login newrelic` on a paid account with MCP enabled → MCP tools callable, including `natural_language_to_nrql_query`. On an account without MCP access (if available), no MCP tool becomes callable. Record the observed failure point.
- **E2E-005**: install `github:jillesmc/compozy-newrelic@v0.1.0` on a clean 0.7.0 profile (Linux) → sources and tools listed; repeat E2E-002 steps 3–6 against the fakes. The operator repeats the install on macOS.
