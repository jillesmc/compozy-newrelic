# Public-docs research for S2 and S4 (conductor, 2026-11-15)

Public sources only; no account, credential or authenticated call used.

## S2: NerdGraph `aiIssues` (source: https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-issues-api-via-github/ ,
raw: https://raw.githubusercontent.com/newrelic/docs-website/develop/src/content/docs/apis/nerdgraph/examples/nerdgraph-issues-api-via-github.mdx)

- Path: `actor { account(id: N) { aiIssues { issues(filter:, cursor:, timeWindow:) { issues {...} nextCursor } } } }`.
- `timeWindow` is optional; default is the last 24 hours ("start and end times in EpochMilliseconds"; input
  type and subfield names not documented, `startTime`/`endTime` likely — UNVERIFIED). Note: open issues older than
  24 h may be excluded by the default window — decide explicitly (pass a wide window only if the field names are
  certain; otherwise omit and record the limitation).
- Paging: start with no cursor (docs show `cursor: ""`), then pass `nextCursor` until it is empty/null.
- Filter input (verbatim):
  ```graphql
  input FilterIssues {
    entityGuids: [EntityGuid!]
    entityTypes: [String!]
    ids: [ID!]
    priority: [String!]
    states: [IssueState!]
  }
  ```
  NO `policyIds` / `conditionIds` filter on issues.
- States: `CREATED`, `ACTIVATED`, `DEACTIVATED`, `CLOSED`. Priority: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.
- Issue fields: `issueId: ID!`, `title: [String!]!` (list of incident titles), `priority`, `state`,
  `entityNames: [String!]`, `entityGuids: [EntityGuid!]`, `entityTypes`, `accountIds: [Int!]!`,
  `description: [String!]!`, `activatedAt`, `createdAt`, `closedAt`, `acknowledgedAt`, `updatedAt: EpochMilliseconds!`,
  `totalIncidents: Int!`, `incidentIds: [String!]`, `isCorrelated`, `isIdle`, `origins`, `sources`.
  NO `conditionName` / `policyName` on Issue (they exist only on Incident: `aiIssues { incidents(...) }` with
  `policyIds`, `conditionFamilyId`...). EpochMilliseconds may be serialized as strings — parse string or number.
- Unconfirmed: a `nerd-graph-unsafe-experimental-opt-in: AiIssues` header (not in the raw docs; do not send it).

## S4: official MCP OAuth contract

- Docs: https://docs.newrelic.com/docs/agentic-ai/mcp/overview/ , https://docs.newrelic.com/docs/agentic-ai/mcp/setup/
  - Endpoints US `https://mcp.newrelic.com/mcp/`, EU `https://mcp.eu.newrelic.com/mcp/` (JP exists).
  - Published public client: client_id `pUWGgnjsQ0bydqCbavTPpw==`, auth `https://oauth2.service.newrelic.com/oauth2/auth`,
    token `https://oauth2.service.newrelic.com/oauth2/token`, scopes `observability:read`, `offline`, `offline_access`.
  - Paid plan required (not Free); org role Organization Read Only / Manager / Product Admin; admin "New Relic MCP
    Server" toggle (on by default). Access tokens 5 min, re-login after 24 h. Some tools OAuth-only.
- Live unauthenticated metadata (2026-11-15):
  - `https://mcp.newrelic.com/.well-known/oauth-protected-resource`:
    `{"resource":"https://mcp.newrelic.com/mcp/","authorization_servers":["https://oauth2.service.newrelic.com"],"bearer_methods_supported":["header"],"scopes_supported":["observability:read","offline","offline_access","dashboards:modify","alerts:modify"]}`
    (EU identical with EU resource).
  - `https://mcp.newrelic.com/.well-known/oauth-authorization-server`:
    `{"issuer":"https://mcp.newrelic.com","authorization_endpoint":"https://oauth2.service.newrelic.com/oauth2/auth","token_endpoint":"https://oauth2.service.newrelic.com/oauth2/token","response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"scopes_supported":[...],"token_endpoint_auth_methods_supported":["none","client_secret_post"],"pkce_required":true,"registration_endpoint":"https://dcr.service.newrelic.com/register","client_id":"pUWGgnjsQ0bydqCbavTPpw==","client_authentication_required":false}`
    (EU identical with issuer `https://mcp.eu.newrelic.com`).
  - Unauthenticated `POST/GET https://mcp.newrelic.com/mcp/` → 401 with
    `www-authenticate: Bearer realm="New Relic MCP", resource_metadata="https://mcp.newrelic.com/.well-known/oauth-protected-resource", scope="..."`.
- DCR caveat: https://github.com/newrelic/mcp-server/issues/7 (open) — the DCR endpoint returns the same fixed
  client_id regardless of input and the auth server rejects non-pre-registered redirect URIs; only loopback
  redirects reported to work. Exact redirect allowlist UNVERIFIED.
- Practical contract: public PKCE S256 client, fixed client_id `pUWGgnjsQ0bydqCbavTPpw==`, loopback redirect,
  scopes `observability:read offline_access` (+ `offline` per docs). Note the issuer in AS metadata is
  `https://mcp.newrelic.com` while endpoints live on `oauth2.service.newrelic.com`.
