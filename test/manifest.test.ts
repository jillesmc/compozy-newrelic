import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createExtension } from "../src/index.ts";
import { MCP_SERVERS, mcpServersToml } from "../src/mcp-servers.ts";
import { SOURCES } from "../src/sources/index.ts";

const AUTH = {
  method: "oauth",
  registration: "pre_registered",
  issuer_url: "https://oauth2.service.newrelic.com",
  client_id: "pUWGgnjsQ0bydqCbavTPpw==",
  scopes: ["observability:read", "offline_access"],
};

describe("manifest", () => {
  test("UT-110 manifest: describe carries the 0.7.0 floor, the API key env and every registered source and tool", () => {
    const payload = createExtension().describe();
    assert.equal(payload.sdk.min_compozy_version, "0.7.0");
    assert.ok((payload.requires_env ?? []).includes("NEW_RELIC_API_KEY"));
    assert.ok(payload.provides.includes("heartbeat.source"));
    assert.deepEqual(
      (payload.heartbeat_source_kinds ?? []).map(kind => kind.kind).sort(),
      SOURCES.map(source => source.kind).sort()
    );
    const hasTools = (payload.tools ?? []).length > 0;
    assert.equal(payload.provides.includes("tool.provider"), hasTools);
  });

  test("UT-110 manifest: OAuth MCP servers newrelic and newrelic-eu use the pre-registered public client, no headers", () => {
    assert.deepEqual(MCP_SERVERS, {
      newrelic: { transport: "http", url: "https://mcp.newrelic.com/mcp/", default_scope: "workspace", auth: AUTH },
      "newrelic-eu": { transport: "http", url: "https://mcp.eu.newrelic.com/mcp/", default_scope: "workspace", auth: AUTH },
    });
    const toml = mcpServersToml();
    assert.doesNotMatch(toml, /headers|api[-_]key|secret/i);
    for (const [name, url] of [["newrelic", "https://mcp.newrelic.com/mcp/"], ["newrelic-eu", "https://mcp.eu.newrelic.com/mcp/"]]) {
      assert.ok(
        toml.includes(
          [
            `[resources.mcp_servers.${name}]`,
            'transport = "http"',
            `url = "${url}"`,
            'default_scope = "workspace"',
            "",
            `[resources.mcp_servers.${name}.auth]`,
            'method = "oauth"',
            'registration = "pre_registered"',
            'issuer_url = "https://oauth2.service.newrelic.com"',
            'client_id = "pUWGgnjsQ0bydqCbavTPpw=="',
            'scopes = ["observability:read", "offline_access"]',
          ].join("\n")
        ),
        name
      );
    }
  });
});
