# Developer Experience: New Relic official MCP proxy (v0.2.0)

## Golden Path

```bash
compozy extension update newrelic --allow-unverified --yes
compozy extension exec newrelic --cmd doctor
```

```text
NerdGraph: ok (region us, 21 accounts visible)
MCP: available (35 tools exposed via API key; 2 OAuth-only hidden) — agents can use ext__newrelic__mcp_tools / mcp_call
```

An agent asks:

```json
{"tool": "ext__newrelic__mcp_tools", "input": {"query": "trace"}}
```

```json
{
  "region": "us",
  "state": "available",
  "exposed": [
    {
      "name": "get_distributed_trace_details",
      "description": "See the complete execution path of a single request across every service it touched.",
      "input": {
        "trace_id": "string — trace id",
        "timestamp": "integer — root span start (ms)",
        "detail_level": "string — summary|…"
      }
    }
  ],
  "hidden": { "oauth_only": 2, "not_read_only": 0 },
  "truncated": false
}
```

Then:

```json
{"tool": "ext__newrelic__mcp_call", "input": {"tool": "list_recent_issues", "arguments": {"account_id": 1234567}}}
```

```json
{"tool": "list_recent_issues", "is_error": false, "text": "{\"issues\": [ ... ]}", "truncated": false}
```

## Refusals and errors

| Condition | Result |
| --- | --- |
| OAuth-only tool (seeded or learned) | tool error `mcp_tool_not_exposed`: `natural_language_to_nrql_query requires OAuth; sign in with compozy mcp auth login newrelic or use another tool` |
| Tool not read-only, or destructive | `mcp_tool_not_exposed`: `<tool> is not marked read-only by New Relic; the proxy does not call it` |
| Unknown or removed tool | `mcp_tool_not_exposed`: `<tool> is not in the New Relic MCP catalog for region us` |
| MCP unavailable for the key | `mcp_unavailable`: `New Relic MCP unavailable for this API key (403); use the ext__newrelic__* NerdGraph tools` |
| Key missing | `credential_absent` (same text as v0.1) |
| 401 | `credential_expired` |
| 429 | `rate_limited` |
| Network, 5xx or timeout | `mcp_request_failed: <status or error>` |
| Remote tool error | `is_error: true`, `text` = the remote message |

## Migration from a manual `newrelicapi` MCP

Remove from the user `config.toml`:

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

## nrql_query nested cells (US-108)

Before: `percentile.duration: "{\"95\":2.31}"`. After: `percentile.duration.95: 2.31`.
