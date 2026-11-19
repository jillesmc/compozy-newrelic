import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { paramsError, SourceError } from "./errors.ts";
import { asObject } from "./params.ts";

/** The per-project file this extension owns (factory-roles ADR-004), relative to a workspace root. */
export const PROJECT_FILE = ".compozy/newrelic.toml";
const MAX_FILE_BYTES = 4096;

export interface ProjectConfig {
  app?: string;
  accountId?: number;
}

/**
 * Reads `<root>/.compozy/newrelic.toml` (`app`, `account_id`). No root or no file → `{}`. Anything
 * else that is not exactly those keys as `key = "string"` / `key = <integer>` lines is refused naming
 * the path, so a typo never silently falls back to the env account.
 */
export function readProjectConfig(root: string | undefined): ProjectConfig {
  if (!root) return {};
  const text = readContained(root);
  if (text === undefined) return {};
  const config: ProjectConfig = {};
  const seen = new Set<string>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))\s*(?:#.*)?$/.exec(line);
    if (!match) throw fileError(`line ${index + 1}: expected key = "string" or key = integer`);
    const key = match[1]!;
    if (seen.has(key)) throw fileError(`line ${index + 1}: duplicate key ${key}`);
    seen.add(key);
    const value = match[2] ?? match[3];
    if (key === "app") {
      if (value === undefined) throw fileError("app must be a string");
      config.app = checkApp(value, `${PROJECT_FILE}: app`);
    } else if (key === "account_id") {
      const id = match[4] === undefined ? NaN : Number(match[4]);
      if (!Number.isSafeInteger(id) || id < 1) throw fileError("account_id must be a positive integer");
      config.accountId = id;
    } else {
      throw fileError(`line ${index + 1}: unknown key ${key} (expected app, account_id)`);
    }
  }
  return config;
}

/**
 * Reads the file only when `.compozy` is a real directory and `newrelic.toml` a regular file of at most
 * 4 KiB, never through a link (review N-2): a link could point at another workspace's values. The file
 * is opened once without following a final link, and type and size are checked on that descriptor
 * before any byte is read. `undefined` when either is absent.
 * ponytail: `.compozy` is checked with lstat, then the file is opened (Node has no openat), so a
 * process that concurrently rewrites the workspace could swap in a link between the two. Out of scope:
 * such a process can already set the values in the file directly. Upgrade path: openat if Node gains it.
 */
function readContained(root: string): string | undefined {
  const dir = join(root, ".compozy");
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw fileError(".compozy must be a real directory, not a link");
    if (!stat.isDirectory()) throw fileError(".compozy must be a directory");
  } catch (error) {
    if (absent(error)) return undefined;
    throw error instanceof SourceError ? error : fileError(`cannot read the file (${errnoCode(error)})`);
  }
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer; fstat refuses it below.
    fd = openSync(join(root, PROJECT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (absent(error)) return undefined;
    if (errnoCode(error) === "ELOOP") throw fileError("the file must be a regular file, not a link");
    throw fileError(`cannot read the file (${errnoCode(error)})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw fileError("the file must be a regular file");
    if (stat.size > MAX_FILE_BYTES) throw fileError("the file is larger than 4 KiB (4096 bytes)");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_FILE_BYTES) throw fileError("the file is larger than 4 KiB (4096 bytes)");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown error";
}

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolves the project values of a source's `with` or a tool's input, first hit wins: explicit
 * `app`/`account_id` → `<root>/.compozy/newrelic.toml` → `NEW_RELIC_ACCOUNT_ID` (account only).
 * Expands `{{app}}` in `where` and drops `app`, so `parse` and fingerprints see resolved values.
 * `root` is the poll's `workspace.root_dir` or the tool call's `trustedWorkspace.root`; without it no
 * file is read. `prefix` is how the caller names its parameters (`with.` for sources).
 */
export function resolveProjectValues(
  raw: unknown,
  env: Record<string, string | undefined>,
  root: string | undefined,
  prefix = "with."
): unknown {
  const obj = asObject(raw);
  if (obj !== raw) return raw; // not an object: let parse report it
  const { app: explicitApp, ...out } = obj;
  const file = readProjectConfig(root);
  if (explicitApp !== undefined && typeof explicitApp !== "string") throw paramsError(`${prefix}app must be a string`);
  const app = explicitApp !== undefined ? checkApp(explicitApp.trim(), `${prefix}app`) : file.app;
  if (out.account_id === undefined) out.account_id = file.accountId ?? envAccount(env);
  if (typeof out.where === "string" && out.where.includes("{{app}}")) {
    if (!app) throw paramsError(`${prefix}where uses {{app}}; set app in ${PROJECT_FILE} or ${prefix}app`);
    out.where = out.where.replaceAll("{{app}}", () => app); // literal: no $& / $` directives (review N-1)
  }
  return out;
}

function envAccount(env: Record<string, string | undefined>): number | undefined {
  const account = env.NEW_RELIC_ACCOUNT_ID?.trim();
  if (!account) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(account) || !Number.isSafeInteger(Number(account))) {
    throw paramsError("NEW_RELIC_ACCOUNT_ID must be a positive integer");
  }
  return Number(account);
}

/** `app` lands inside a NRQL string literal: no quotes or backslashes, never echoed back. */
function checkApp(app: string, label: string): string {
  if (app === "" || app.length > 256) throw paramsError(`${label} must be a non-empty string of at most 256 characters`);
  if (/['"\\]/.test(app)) throw paramsError(`${label} must not contain quotes or backslashes`);
  return app;
}

function fileError(reason: string) {
  return paramsError(`${PROJECT_FILE}: ${reason}`);
}
