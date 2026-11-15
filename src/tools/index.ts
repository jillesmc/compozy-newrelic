import type { ExtensionToolHandler } from "@compozy/extension-sdk";

import { formatReport, runDoctor } from "../doctor.ts";
import { asObject, parseRegion } from "../params.ts";
import { toolError } from "./format.ts";
import { alertIssuesTool, listAccountsTool, searchEntitiesTool } from "./graph-tools.ts";
import { errorGroupsTool, nrqlQueryTool, recentLogsTool } from "./nrql-tools.ts";
import { nerdgraphTool, REGION_PROPERTY, type ToolDefinition, type ToolDeps } from "./tool.ts";

export type { ToolDeps } from "./tool.ts";

/** Operator probe; model-visible only because SDK tools always are (ADR-002). */
export const doctorTool: ToolDefinition = {
  name: "doctor",
  description:
    "Operator command (compozy extension exec newrelic --cmd doctor). Agents should not call this tool: " +
    "it only reports whether NerdGraph and the official New Relic MCP are reachable for this API key.",
  inputSchema: { type: "object", additionalProperties: false, properties: { region: REGION_PROPERTY } },
  command: {
    verb: "doctor",
    summary: "Check NerdGraph access and whether the official New Relic MCP is usable",
    example: "--region eu",
    flags: { region: "region" },
  },
  async handle(input, deps) {
    return formatReport(await runDoctor(parseRegion(input.region), deps));
  },
};

/** Every registered tool, exposed as ext__newrelic__<name> (US-008, US-010). */
export const TOOLS: ToolDefinition[] = [
  nerdgraphTool(nrqlQueryTool),
  nerdgraphTool(listAccountsTool),
  nerdgraphTool(searchEntitiesTool),
  nerdgraphTool(alertIssuesTool),
  nerdgraphTool(errorGroupsTool),
  nerdgraphTool(recentLogsTool),
  doctorTool,
];

/** SDK handler: failures become structured tool errors (`credential_absent`, `params_invalid`, ...). */
export function toolHandler(tool: ToolDefinition, deps: ToolDeps): ExtensionToolHandler {
  return async ({ input }) => {
    try {
      return await tool.handle(asObject(input), deps);
    } catch (error) {
      throw toolError(error);
    }
  };
}
