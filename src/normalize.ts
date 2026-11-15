import { createHash } from "node:crypto";

/** Daemon item-key pattern (CompozyOS 0.7.0 `internal/heartbeat/source/source.go:85`). */
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,199}$/;
const MAX_KEY_BYTES = 200;
const LONG_KEY_PREFIX = 180;
const MAX_MESSAGE_CHARS = 160;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Maps a raw key onto the daemon alphabet (Business Rule 3, Deviation D-2). Valid keys are kept
 * verbatim; a lossy mapping appends `#` + 8 hex of the raw key's hash so distinct raw values never
 * collide; a key over 200 bytes keeps a 180-byte prefix plus `#` + 12 hex of the raw key's hash.
 */
export function sanitizeKey(raw: string): string {
  if (KEY_PATTERN.test(raw)) return raw;
  let mapped = raw.replace(/[^A-Za-z0-9._:/#@+-]/g, "-");
  if (!/^[A-Za-z0-9]/.test(mapped)) mapped = `x${mapped}`;
  const hash = sha256Hex(raw);
  const lossy = `${mapped}#${hash.slice(0, 8)}`;
  // Every character is ASCII after mapping, so length equals byte length.
  return lossy.length <= MAX_KEY_BYTES ? lossy : `${mapped.slice(0, LONG_KEY_PREFIX)}#${hash.slice(0, 12)}`;
}

/**
 * Error-message normalization (Business Rule 4): UUIDs, hex ids of 8+ characters, digit runs and
 * quoted strings collapse to `#`; whitespace runs collapse to one space; at most 160 characters.
 * Case is preserved.
 */
export function normalizeMessage(message: string): string {
  const collapsed = message
    .replace(/'[^']*'|"[^"]*"/g, "#")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#")
    .replace(/\b(?=[0-9a-f]*[0-9])[0-9a-f]{8,}\b/gi, "#")
    .replace(/[0-9]+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(collapsed).slice(0, MAX_MESSAGE_CHARS).join("");
}
