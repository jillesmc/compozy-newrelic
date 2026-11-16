import type { HeartbeatSourceItem, JSONValue } from "@compozy/extension-sdk";

export const MAX_TITLE_CHARS = 200;
export const MAX_SUMMARY_BYTES = 1024;
export const MAX_ATTRIBUTES_BYTES = 2048;
const ATTRIBUTE_CHARS = 200;

const MARKER = "[redacted]";

/** Replaces every occurrence of the bound API key with `[redacted]`. */
export function redactor(apiKey: string): (text: string) => string {
  return text => (apiKey ? text.split(apiKey).join(MARKER) : text);
}

/** Deep-copies JSON data, redacting every string (keys included) before anything is clipped. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(entry => redactDeep(entry, redact)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [redact(name), redactDeep(entry, redact)])
    ) as T;
  }
  return value;
}

/** Locale-free fixed formatting: at most 6 significant digits, no exponent below 1e21. */
export function formatNumber(value: number): string {
  // D-22: integers (counts, epoch timestamps) print exactly; large fractions keep 2 decimals.
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 100_000) return String(Math.round(value * 100) / 100);
  return String(Number(value.toPrecision(6)));
}

/** UTC ISO timestamp from the request clock; unparseable input is returned unchanged. */
export function isoUtc(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function truncateBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (byteLength(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * Fits attributes into the daemon's 2 KiB: strings are clipped to 200 characters, then the keys in
 * `dropOrder` are removed one by one, then every string is clipped harder until the JSON fits.
 */
export function boundAttributes(
  attributes: Record<string, JSONValue>,
  dropOrder: string[] = []
): Record<string, JSONValue> {
  const fits = (value: Record<string, JSONValue>) =>
    byteLength(JSON.stringify(value)) <= MAX_ATTRIBUTES_BYTES;
  const clip = (value: Record<string, JSONValue>, max: number) =>
    Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        typeof entry === "string" ? truncateChars(entry, max) : entry,
      ])
    );
  let current = { ...attributes };
  for (const name of dropOrder) {
    if (fits(current)) return current;
    delete current[name];
  }
  for (let max = ATTRIBUTE_CHARS; !fits(current) && max > 1; max = Math.max(1, max - 20)) {
    current = clip(current, max);
  }
  return current;
}

/** Builds a daemon-valid item: title ≤ 200 characters, summary ≤ 1 KiB, attributes ≤ 2 KiB. */
export function shapeItem(input: {
  key: string;
  title: string;
  summary: string;
  url?: string;
  attributes: Record<string, JSONValue>;
  dropOrder?: string[];
}): HeartbeatSourceItem {
  return {
    key: input.key,
    title: truncateChars(input.title, MAX_TITLE_CHARS),
    summary: truncateBytes(input.summary, MAX_SUMMARY_BYTES),
    ...(input.url ? { url: input.url } : {}),
    attributes: boundAttributes(input.attributes, input.dropOrder),
  };
}
