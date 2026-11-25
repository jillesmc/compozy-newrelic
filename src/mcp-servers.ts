/**
 * OAuth-only declaration of the official New Relic MCP (ADR-002, spec deviation D-S4-a).
 *
 * CompozyOS 0.7.0 has no MCP-server field in the SDK describe contract, so `compozy extension build`
 * cannot emit these. `scripts/package.ts` appends `mcpServersToml()` to the built generation's
 * extension.toml. Pre-registered public client: New Relic publishes a fixed client id (PKCE S256, no
 * secret); its DCR endpoint returns that same id, so dynamic registration adds nothing.
 * `default_scope = "global"` lets a plain `compozy extension install` (no `--scope`) install for all
 * projects; `--scope workspace` still selects one workspace (spec deviation D-16).
 * Only the US server is declared: an extension manifest cannot ship a server switched off, and an
 * EU server nobody signs in to shows as an unhealthy MCP server. EU accounts declare `newrelic-eu`
 * by hand (README, Official MCP via OAuth).
 */
export interface McpServerDeclaration {
  transport: "http";
  url: string;
  default_scope: "global";
  auth: {
    method: "oauth";
    registration: "pre_registered";
    issuer_url: string;
    client_id: string;
    scopes: string[];
  };
}

const AUTH: McpServerDeclaration["auth"] = {
  method: "oauth",
  registration: "pre_registered",
  issuer_url: "https://oauth2.service.newrelic.com",
  client_id: "pUWGgnjsQ0bydqCbavTPpw==",
  scopes: ["observability:read", "offline_access"],
};

export const MCP_SERVERS: Readonly<Record<string, McpServerDeclaration>> = {
  newrelic: { transport: "http", url: "https://mcp.newrelic.com/mcp/", default_scope: "global", auth: AUTH },
};

const str = (value: string): string => JSON.stringify(value);

/** `[resources.mcp_servers.*]` TOML tables; JSON strings are valid TOML basic strings for these values. */
export function mcpServersToml(servers: Readonly<Record<string, McpServerDeclaration>> = MCP_SERVERS): string {
  return Object.entries(servers)
    .map(([name, server]) =>
      [
        `[resources.mcp_servers.${name}]`,
        `transport = ${str(server.transport)}`,
        `url = ${str(server.url)}`,
        `default_scope = ${str(server.default_scope)}`,
        "",
        `[resources.mcp_servers.${name}.auth]`,
        `method = ${str(server.auth.method)}`,
        `registration = ${str(server.auth.registration)}`,
        `issuer_url = ${str(server.auth.issuer_url)}`,
        `client_id = ${str(server.auth.client_id)}`,
        `scopes = [${server.auth.scopes.map(str).join(", ")}]`,
        "",
      ].join("\n")
    )
    .join("\n");
}
