import pino, { type Logger } from "pino";

export type { Logger };

const isDev = process.env.NODE_ENV !== "production";

/**
 * Root logger. Every log line is JSON; attach context with `logger.child({ orderId })`
 * so a single order can be followed across web and worker.
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  base: { service: process.env.SERVICE_NAME ?? "woolrus" },
  redact: {
    paths: ["*.password", "*.pin", "*.token", "*.apiKey", "*.secret", "req.headers.authorization"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
