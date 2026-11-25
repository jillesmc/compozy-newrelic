# Test Specification: New Relic official MCP proxy (v0.2.0)

## Strategy

- `bun test`, plus the Node 22 suite.
- A fake Streamable-HTTP MCP server (`node:http`) supports:
  - JSON and SSE response modes;
  - `Mcp-Session-Id` issue, echo and expiry;
  - `tools/list` paging;
  - per-tool behaviors (ok, remote error, 403 `requires OAuth`, slow).
- Injected clock. Test names carry their IDs.

## Coverage Matrix

| Source | Unit | Integration | E2E |
| --- | --- | --- | --- |
| US-101 | UT-130, UT-131, UT-132 | IT-101 | E2E-101 |
| US-102 | UT-140, UT-141, UT-142 | IT-102, IT-103, IT-104 | E2E-101 |
| US-103 | UT-150, UT-151, UT-152 | IT-105 | E2E-102 |
| US-104 | UT-160 | IT-106 | — |
| US-105 | UT-170, UT-171 | IT-107 | E2E-102 |
| US-106 | — | — | E2E-103 (operator) |
| US-107 | — | — | E2E-104 |
| US-108 | UT-180 | — | — |
| BR-7 redaction | UT-190 | — | — |
| BR-9 sources isolation | UT-123 (extended to `mcp-client`/`mcp-catalog`) | — | — |

## Unit Tests

- **UT-130** (happy): the catalog filter keeps only `readOnlyHint:true` tools without `destructiveHint:true` that are not on the OAuth list; the hidden counts are correct.
- **UT-131** (happy): `query` is a case-insensitive substring over name and description. `limit` caps the rows and sets `truncated`.
- **UT-132** (boundary): the input schema is compacted to `prop: "type — description"`, with the description at most 80 characters.
- **UT-140** (happy): the call result concatenates text parts; it is capped at 16 KiB with `truncated` set.
- **UT-141** (boundary): `structuredContent` up to 16 KiB is passed through; above that it is replaced by text.
- **UT-142** (error): `arguments` over 64 KiB are refused locally.
- **UT-150** (error): calling a seeded OAuth-only tool gives `mcp_tool_not_exposed oauth_only`, with zero fetch calls.
- **UT-151** (error): calling an unannotated or destructive tool gives `not_read_only`, with zero fetch calls.
- **UT-152** (state): `learnOAuthOnly` hides the tool and blocks the next call; one stderr line is written.
- **UT-160** (state): the TTL expiry triggers a refresh. A failed refresh keeps the old catalog for at most one more TTL, then the state becomes `unavailable`.
- **UT-170** (error): probe 403 makes both tools return `mcp_unavailable`, with zero fetch calls after the probe.
- **UT-171** (state): state `unknown` is re-probed at most once per minute.
- **UT-180** (happy): nested aggregates are flattened to dotted keys, to a depth of 3.
- **UT-190** (error): a key echoed in the remote text or error is redacted.
- **UT-200** (happy, D-24): `{{key}}` in `where` and `facet` expands from any string key of the project file, literally and in one pass (sources and tools).
- **UT-201** (edge, D-24): a placeholder whose key nobody sets (including `{{app}}`) makes a source return no items with its state unchanged, one `skipped` stderr line and no request; a tool fails with `tool_invalid_input`.
- **UT-202** (error, D-24): `;`, `{{` or `}}` in a string value, a non-string custom key and a bad `accounts` list are refused naming the file.
- **UT-203** (happy, D-24): account resolution order (explicit `account_id` → `account_ids` → file `accounts` → file `account_id` → env); two or more ids use the cross-account query; single-account tools skip `accounts`.
- **UT-204** (happy, D-24): cross-account `logs`, `errors` and `issues` items are keyed and labelled per account; `nrql` runs the NRQL as written.
- **UT-205** (regression, D-24): a workspace with only `app` and `account_id` gives the v0.5.0 requests, items and state byte for byte.

## Integration Tests (fake MCP)

- **IT-101**: `initialize`, `notifications/initialized` and paged `tools/list` (2 pages) produce the merged, filtered catalog. The `api-key` header and `Mcp-Session-Id` are echoed.
- **IT-102**: `tools/call` returns the result in JSON mode.
- **IT-103**: `tools/call` returns the result in SSE mode (one `data:` event carrying the JSON-RPC response).
- **IT-104**: a session expiry (404 on call) is followed by one re-initialize, and the call succeeds. A second expiry within the same call returns an error.
- **IT-105**: a tool answering 403 `requires OAuth` is learned and not listed afterwards.
- **IT-106**: the fake adds a tool. After the TTL it is listed and callable; after removal, `unknown_tool`.
- **IT-107**: initialize 404 or 403 makes the doctor print `unavailable` and the tools return `mcp_unavailable`.

## End-to-End

- **E2E-101** (local daemon, fake MCP via loopback region): install the build, call `mcp_tools` then `mcp_call` through a temporary agent with the tools granted, and check the bounded output.
- **E2E-102**: same setup with OAuth-only and destructive fake tools, which are never offered. A probe 403 gives `mcp_unavailable`.
- **E2E-103** (operator-run, real key): migrate from `newrelicapi`. Run `mcp_tools` and record the counts and SSE or JSON mode. Call `list_recent_issues`, `get_distributed_trace_details` and `analyze_transactions`.
- **E2E-104**: install `github:jillesmc/compozy-newrelic@v0.2.0` on a clean 0.7.0 profile, both with and without `--scope` per the US-107 outcome. Then list the tools.
