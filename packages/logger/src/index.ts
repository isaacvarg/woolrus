import type { Writable } from "node:stream";
import pino, { type Logger } from "pino";

export type { Logger };

const isDev = process.env.NODE_ENV !== "production";

/**
 * Customer PII keys (SPEC-operations "Error tracking"). Logs redact them here; error reports and
 * audit rows scrub the same list, so all three agree on what counts as personal data.
 */
export const PII_KEYS = [
  "customerName",
  "customerEmail",
  "email",
  "phone",
  "first_name",
  "last_name",
  "address_1",
  "address_2",
  "shippingAddress",
  "billingAddress",
  "shipTo",
  "shipToOriginal",
  "customerNote",
] as const;

const SECRET_PATHS = ["*.password", "*.pin", "*.token", "*.apiKey", "*.secret"];

/** Matches `{ key }` at the top level and one or two objects down (`*.key`, `*.*.key`). */
const REDACT_PATHS = [
  ...SECRET_PATHS,
  "req.headers.authorization",
  ...PII_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
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
