import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRelease } from "../scripts/package.ts";
import { createExtension } from "../src/index.ts";
import { MCP_SERVERS, mcpServersToml } from "../src/mcp-servers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KINDS = ["errors", "issues", "logs", "nrql"];
const TOOL_IDS = ["alert_issues", "doctor", "error_groups", "list_accounts", "mcp_call", "mcp_tools", "nrql_query", "recent_logs", "search_entities"].map(
  name => `ext__newrelic__${name}`
);

type Describe = ReturnType<ReturnType<typeof createExtension>["describe"]>;

/** UT-110 describe contract, shared by the in-process and the packaged-bundle checks. */
function assertDescribe(payload: Describe): void {
  assert.equal(payload.sdk.min_compozy_version, "0.7.0");
  assert.deepEqual(payload.requires_env, ["NEW_RELIC_ACCOUNT_ID", "NEW_RELIC_API_KEY"]);
  assert.deepEqual([...payload.provides].sort(), ["heartbeat.source", "tool.provider"]);
  assert.deepEqual((payload.heartbeat_source_kinds ?? []).map(kind => kind.kind).sort(), KINDS);
  const tools = payload.tools ?? [];
  assert.deepEqual(tools.map(tool => tool.id).sort(), TOOL_IDS);
  assert.deepEqual(tools.filter(tool => tool.risk !== "read" || tool.read_only !== true).map(tool => tool.id), []);
  assert.deepEqual(
    tools.filter(tool => tool.command).map(tool => [tool.id, tool.command?.verb]),
    [["ext__newrelic__doctor", "doctor"]]
  );
}

const AUTH = {
  method: "oauth",
  registration: "pre_registered",
  issuer_url: "https://oauth2.service.newrelic.com",
  client_id: "pUWGgnjsQ0bydqCbavTPpw==",
  scopes: ["observability:read", "offline_access"],
};

describe("manifest", () => {
  test("UT-110 manifest: describe carries exactly the 0.7.0 floor, the env keys, 4 kinds, 9 tools (incl. the MCP proxy) and the doctor command", () => {
    const payload = createExtension().describe();
    assertDescribe(payload);
  });

  test("UT-110 manifest: the OAuth MCP server newrelic (US only) uses the pre-registered public client, no headers", () => {
    assert.deepEqual(MCP_SERVERS, {
      newrelic: { transport: "http", url: "https://mcp.newrelic.com/mcp/", default_scope: "global", auth: AUTH },
    });
    const toml = mcpServersToml();
    assert.doesNotMatch(toml, /headers|api[-_]key|secret/i);
    for (const [name, url] of [["newrelic", "https://mcp.newrelic.com/mcp/"]]) {
      assert.ok(
        toml.includes(
          [
            `[resources.mcp_servers.${name}]`,
            'transport = "http"',
            `url = "${url}"`,
            'default_scope = "global"',
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

  const compozy = spawnSync("compozy", ["--version"], { encoding: "utf8" });
  test(
    "UT-110 manifest: the packaged release (compozy extension build + MCP servers) is valid and complete",
    { skip: compozy.status !== 0 ? "compozy CLI not installed" : false, timeout: 240_000 },
    () => {
      const out = mkdtempSync(join(tmpdir(), "newrelic-gen-"));
      try {
        // The generation is built in <root>/dist like `bun run package` (gitignored; it clears
        // dist/release); the release copy goes to a temp directory.
        const { releaseDir } = buildRelease({ sourceDir: ROOT, releaseDir: join(out, "release") });
        const toml = readFileSync(join(releaseDir, "extension.toml"), "utf8");
        assert.match(toml, /^\s*min_compozy_version = "0\.7\.0"$/m);
        assert.match(toml, /^\s*requires_env = \["NEW_RELIC_ACCOUNT_ID", "NEW_RELIC_API_KEY"\]$/m);
        assert.match(toml, /^\s*provides = \["heartbeat\.source", "tool\.provider"\]$/m);
        assert.deepEqual([...toml.matchAll(/^\s*id = "(ext__newrelic__\w+)"$/gm)].map(m => m[1]).sort(), TOOL_IDS);
        assert.deepEqual([...toml.matchAll(/^\s*\[resources\.tools\.(\w+)\.command\]$/gm)].map(m => m[1]), ["doctor"]);
        assert.match(toml, /^\s*verb = "doctor"$/m);
        assert.ok(toml.includes(mcpServersToml()), "the OAuth MCP server is appended");
        assert.deepEqual([...toml.matchAll(/^\[resources\.mcp_servers\.([\w-]+)\]$/gm)].map(m => m[1]), ["newrelic"]);

        const validate = spawnSync("compozy", ["extension", "validate", releaseDir, "-o", "json"], { encoding: "utf8" });
        assert.equal(validate.status, 0, `validate: ${validate.stdout}${validate.stderr}`);
        const report = JSON.parse(validate.stdout) as { status: string; issues: unknown[] };
        assert.deepEqual([report.status, report.issues], ["valid", []]);

        // Source kinds are described at runtime: ask the packaged bundle itself.
        const described = spawnSync(process.execPath, [join(releaseDir, "index.js"), "__describe"], { encoding: "utf8" });
        assert.equal(described.status, 0, `describe: ${described.stdout.slice(0, 200)}${described.stderr}`);
        assertDescribe(JSON.parse(described.stdout) as Describe);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
  );
});
