import { pathToFileURL } from "node:url";

import { Extension, type ExtensionOptions } from "@compozy/extension-sdk";

import { startupProbe } from "./doctor.ts";
import { createPollHandler, type PollDeps } from "./poll.ts";
import { SOURCES } from "./sources/index.ts";
import { trustSystemCertificates } from "./system-ca.ts";
import { createProxyCatalog, toolHandler, TOOLS, type ToolDeps } from "./tools/index.ts";

export const EXTENSION_VERSION = "0.5.0";
/**
 * Supported CompozyOS floor. The TS SDK 0.7.0 describe payload still carries its stale built-in floor
 * "0.3.0-beta.1" and `compozy extension build` stamps extension.toml from it, so it is set here.
 */
export const MIN_COMPOZY_VERSION = "0.7.0";
export const REQUIRED_ENV = ["NEW_RELIC_API_KEY"];
/**
 * Optional standalone account default (below `.compozy/newrelic.toml`). SDK 0.7.0 has no optional-env
 * field, so it is declared in `requires_env` too (that is what lets `secrets set --env` accept it); the
 * daemon keeps the extension active while it is unset, and the code treats it as optional.
 * `NEW_RELIC_APP` is gone (factory-roles ADR-004): the app comes from the project file or a parameter.
 */
export const OPTIONAL_ENV = ["NEW_RELIC_ACCOUNT_ID"];

class NewRelicExtension extends Extension {
  public override describe(): ReturnType<Extension["describe"]> {
    const payload = super.describe();
    return { ...payload, sdk: { ...payload.sdk, min_compozy_version: MIN_COMPOZY_VERSION } };
  }
}

export type NewRelicExtensionDeps = PollDeps & ToolDeps;

/** The only module that builds the SDK Extension and reads process.env (through PollDeps defaults). */
export function createExtension(options: ExtensionOptions = {}, deps: NewRelicExtensionDeps = {}): Extension {
  const extension = new NewRelicExtension(
    {
      name: "newrelic",
      version: EXTENSION_VERSION,
      description: "New Relic check-in sources and investigation tools",
      subprocess: { command: "node", args: ["index.js"] },
      capabilities: { provides: [] },
      permissions: { requires: [] },
      requires_env: [...REQUIRED_ENV, ...OPTIONAL_ENV],
    },
    options
  );
  const env = deps.env ?? process.env;
  for (const source of SOURCES) {
    extension.heartbeatSource(
      source.kind,
      { title: source.title, description: source.description, params_schema: source.params_schema },
      createPollHandler(source, { ...deps, env })
    );
  }
  // One MCP catalog per process, shared by mcp_tools and mcp_call (TTL cache, OAuth-only set).
  const toolDeps: ToolDeps = { ...deps, env };
  toolDeps.mcp ??= createProxyCatalog(toolDeps);
  for (const tool of TOOLS) {
    const { name, description, inputSchema, command } = tool;
    extension.tool(name, { description, inputSchema, readOnly: true, ...(command ? { command } : {}) }, toolHandler(tool, toolDeps));
  }
  // One probe line at start (US-010.AC-2); onReady never runs in __describe mode and never blocks startup.
  // The probe shares the proxy catalog, so its MCP result is the proxy's region state (D-19).
  extension.onReady(() => void startupProbe({ ...deps, env, mcp: toolDeps.mcp }));
  return extension;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  // Before any request: company hosts behind TLS inspection need the OS CA store.
  trustSystemCertificates();
  void createExtension().start();
}
