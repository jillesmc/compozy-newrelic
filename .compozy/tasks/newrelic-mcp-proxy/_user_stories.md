# User Stories: New Relic official MCP proxy (v0.2.0)

Personas as in `../newrelic-sources/_user_stories.md` (Operator, Agent, Installer).

| ID | Area | Persona | Story |
| --- | --- | --- | --- |
| US-101 | Proxy | Agent | List the official MCP tools that work for this key |
| US-102 | Proxy | Agent | Call any exposed official MCP tool with bounded output |
| US-103 | Proxy | Agent | Never be offered a tool that is OAuth-only or not read-only |
| US-104 | Proxy | Agent | Get new New Relic tools without an extension release |
| US-105 | Proxy | Agent | Get one immediate answer when the MCP is unavailable for the key |
| US-106 | Operate | Operator | Replace the manual `newrelicapi` MCP with the extension |
| US-107 | Install | Installer | Install without having to know about `--scope` |
| US-108 | Tools | Agent | Read nested NRQL aggregates as plain values |

### US-101: List working tools

**As an** agent, **I want** `ext__newrelic__mcp_tools` to list the official tools usable with the
bound key, **so that** I can pick one.

- AC-1: With the key bound on an MCP-enabled account, the result has `state: available`, `exposed`
  rows with name, short description and compact input, and `hidden` counts.
- AC-2: `query: "trace"` returns only tools whose name or description contains "trace" (case-insensitive).
- AC-3: `region: eu` lists the EU catalog.
- EC-1: More than 60 matches → 60 rows and `truncated: true`.

### US-102: Call a tool

- AC-1: `mcp_call {tool: "list_recent_issues", arguments: {account_id: 1234567}}` returns `is_error: false`
  and the tool's text (≤ 16 KiB).
- AC-2: A remote tool error (bad arguments) returns `is_error: true` with the remote message.
- EC-1: The result is over 16 KiB → it is truncated with `truncated: true`.
- EC-2: `arguments` over 64 KiB → refused locally.
- EC-3: The session expired → it is re-initialized once and the call succeeds.

### US-103: Never offered a dead or unsafe tool

- AC-1: `natural_language_to_nrql_query` is never listed and calling it returns
  `mcp_tool_not_exposed (oauth_only)` with no network call.
- AC-2: A tool without `readOnlyHint: true`, or with `destructiveHint: true`, is never listed and is
  refused as `not_read_only`.
- AC-3: A tool that returns 403 `requires OAuth` once is learned as OAuth-only and is never listed or
  forwarded again in that process.

### US-104: New tools without release

- AC-1: A tool added to the remote `tools/list` (read-only annotated) appears within 10 minutes and is
  callable.
- AC-2: A tool removed remotely disappears within 10 minutes. Calling it returns `unknown_tool`.

### US-105: Unavailable MCP

- AC-1: On a key whose account has no MCP (initialize 403/404), both tools return `mcp_unavailable`
  with the reason and the hint to use the NerdGraph tools, without a remote request (after the probe).
- AC-2: The doctor prints `MCP: unavailable (...)`, and with the MCP available it prints
  `MCP: available (N tools exposed via API key; M hidden)`.

### US-106: Migrate from `newrelicapi`

- AC-1: The README shows the exact removal of the `newrelicapi` `[[mcp_servers]]` block and its
  `trusted_sources` entry, keeping `"extension:newrelic"`.
- AC-2: After migration, every tool the agent used through `newrelicapi` (except OAuth-only ones) is
  reachable through `mcp_call`.

### US-107: Install without `--scope`

- AC-1: Investigate whether declaring the OAuth servers with a non-workspace `default_scope` lets
  `compozy extension install github:jillesmc/compozy-newrelic@v0.2.0 --allow-unverified --yes`
  succeed outside a workspace, and confirm OAuth login still works per scope. If it does, ship it. If
  not, keep `--scope global` in the README and record the reason as a deviation.

### US-108: Nested NRQL cells

- AC-1: `nrql_query` renders `percentile(duration, 95)` as `percentile.duration.95: 2.31` instead of a
  JSON string. Other nested objects are flattened with dotted keys, to a depth of 3.
