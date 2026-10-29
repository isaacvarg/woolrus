import type { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { isPiiKey, isPiiMetaPair, maskEmails, PAIR_VALUES, PII_KEYS } from "./pii";

export type { Logger };
export { isPiiKey, isPiiMetaPair, maskEmails, PAIR_VALUES, PII_KEYS };

const isDev = process.env.NODE_ENV !== "production";

const SECRET_PATHS = ["*.password", "*.pin", "*.token", "*.apiKey", "*.secret"];

const words = (key: string) =>
  key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/);
const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** pino paths are case-sensitive, so list the usual spellings of each key: camel, snake, Title, UPPER; no kebab, which isn't a valid path. */
function spellings(key: string): string[] {
  const parts = words(key);
  const camel = parts.map((word, i) => (i === 0 ? word : cap(word)));
  return [
    ...new Set([
      key,
      camel.join(""),
      parts.join("_"),
      parts.map(cap).join("_"),
      parts.map(cap).join(""),
      parts.join("_").toUpperCase(),
      parts.join("").toLowerCase(),
    ]),
  ];
}

/** Matches `{ key }` at the top level and one or two objects down (`*.key`, `*.*.key`). */
const REDACT_PATHS = [
  ...SECRET_PATHS,
  "req.headers.authorization",
  ...PII_KEYS.flatMap(spellings).flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

/** Every log line is JSON. `destination` is for tests; the default is stdout. */
export function buildLogger(destination?: Writable): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
      base: { service: process.env.SERVICE_NAME ?? "woolrus" },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

/**
 * Root logger. Attach context with `logger.child({ orderId })` so a single order can be followed
 * across web and worker.
 */
export const logger: Logger = buildLogger();

export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
export { type ScrubbableEvent, scrubEvent } from "./scrub";
