/**
 * Installable package: `compozy extension build`, then a copy of that generation at dist/release with
 * the OAuth MCP servers appended to extension.toml (spec deviation D-S4-a), then `compozy extension
 * validate`. Install and publish dist/release, not dist/gen-*. The next build clears dist/release.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, rmSync } from "node:fs";

import { mcpServersToml } from "../src/mcp-servers.ts";

const RELEASE_DIR = "dist/release";

const built = execFileSync("compozy", ["extension", "build", ".", "-o", "json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const { generation_dir: generationDir } = JSON.parse(built) as { generation_dir: string };
rmSync(RELEASE_DIR, { recursive: true, force: true });
cpSync(generationDir, RELEASE_DIR, { recursive: true });
appendFileSync(`${RELEASE_DIR}/extension.toml`, `\n${mcpServersToml()}`);
execFileSync("compozy", ["extension", "validate", RELEASE_DIR], { stdio: "inherit" });
process.stdout.write(`package: ${RELEASE_DIR} (from ${generationDir})\n`);
