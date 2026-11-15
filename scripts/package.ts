/**
 * Installable package: `compozy extension build`, then a copy of that generation at dist/release with
 * the OAuth MCP servers appended to extension.toml (spec deviation D-S4-a), then `compozy extension
 * validate`. Install and publish dist/release, not dist/gen-*. The next build clears dist/release.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { mcpServersToml } from "../src/mcp-servers.ts";

export const RELEASE_DIR = "dist/release";

/**
 * Builds a generation under <source>/dist and writes the release copy. The generation must stay in
 * <source>/dist: `compozy extension build` copies the loose artifacts of its output directory, and
 * `bun run build` always writes dist/index.js, so another `--output-dir` yields no index.js.
 */
export function buildRelease(
  options: { sourceDir?: string; releaseDir?: string } = {}
): { generationDir: string; releaseDir: string } {
  const releaseDir = options.releaseDir ?? RELEASE_DIR;
  const built = execFileSync("compozy", ["extension", "build", options.sourceDir ?? ".", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const { generation_dir: generationDir } = JSON.parse(built) as { generation_dir: string };
  rmSync(releaseDir, { recursive: true, force: true });
  cpSync(generationDir, releaseDir, { recursive: true });
  if (!existsSync(`${releaseDir}/index.js`)) throw new Error(`package: ${generationDir} has no index.js`);
  appendFileSync(`${releaseDir}/extension.toml`, `\n${mcpServersToml()}`);
  return { generationDir, releaseDir };
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const { generationDir, releaseDir } = buildRelease();
  execFileSync("compozy", ["extension", "validate", releaseDir], { stdio: "inherit" });
  process.stdout.write(`package: ${releaseDir} (from ${generationDir})\n`);
}
