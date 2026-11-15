import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every .ts file under src/sources (new kinds are picked up automatically) plus src/engine.ts. */
function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });
  return [...walk(join(ROOT, "src/sources")), join(ROOT, "src/engine.ts")];
}

const ALLOWED_PACKAGES = new Set(["node:crypto", "@compozy/extension-sdk"]);
const FORBIDDEN_IMPORT = /doctor|mcp|tools\/|openai|anthropic|langchain|\bai\b/i;
const FORBIDDEN_CODE: Array<[RegExp, string]> = [
  [/\bmcp\b|mcp[A-Z_]|Mcp/i, "MCP client or probe"],
  [/doctor/i, "doctor probe"],
  [/natural_?language|nl2nrql|askNrql|\bllm\b|openai|anthropic|generative|completion/i, "AI endpoint"],
  [/\bfetch\s*\(|https?:\/\//, "direct network access (sources use the injected NerdGraph client)"],
  [/Date\.now|performance\.now|new Date\(\s*\)|Math\.random|toLocale|Intl\./, "wall clock, randomness or locale"],
];

/** Violations in one file's text: forbidden imports and forbidden calls outside comments. */
export function violations(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const found: string[] = [];
  for (const match of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    const relativeOk = specifier.startsWith(".") && !FORBIDDEN_IMPORT.test(specifier);
    if (!relativeOk && !ALLOWED_PACKAGES.has(specifier)) found.push(`import ${specifier}`);
  }
  const withoutImports = code.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?/gm, "");
  for (const [pattern, label] of FORBIDDEN_CODE) {
    if (pattern.test(withoutImports)) found.push(label);
  }
  return found;
}

describe("determinism (static)", () => {
  test("UT-123 static: no source or engine code path reaches an MCP client (mcp-client, mcp-catalog), the doctor probe, or an AI endpoint", () => {
    const files = sourceFiles();
    assert.ok(files.some(file => file.endsWith("nrql.ts")));
    for (const file of files) {
      assert.deepEqual(violations(readFileSync(file, "utf8")), [], relative(ROOT, file));
    }
  });

  test("UT-123 static: the scanner flags each forbidden form", () => {
    assert.deepEqual(violations('import { probeMcp } from "../doctor.ts";\nawait probeMcp();'), ["import ../doctor.ts", "MCP client or probe"]);
    assert.deepEqual(violations('import { x } from "openai";'), ["import openai"]);
    // Business Rule 9 (v0.2): the MCP proxy client and catalog are out of reach of sources and the engine.
    assert.deepEqual(violations('import { createMcpClient } from "../mcp-client.ts";'), ["import ../mcp-client.ts"]);
    assert.deepEqual(violations('import type { McpCatalog } from "./mcp-catalog.ts";'), ["import ./mcp-catalog.ts"]);
    assert.deepEqual(violations('const { callTool } = await import("../tools/mcp-proxy.ts");'), ["import ../tools/mcp-proxy.ts", "MCP client or probe"]);
    assert.deepEqual(violations("await client.callTool('natural_language_to_nrql_query');"), ["AI endpoint"]);
    assert.deepEqual(violations("await fetch(url);"), ["direct network access (sources use the injected NerdGraph client)"]);
    assert.deepEqual(violations("const t = Date.now();"), ["wall clock, randomness or locale"]);
    assert.deepEqual(violations("// the MCP is never called here\nconst a = 1;"), []);
  });
});
