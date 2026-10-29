import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@woolrus/logger";

/**
 * GlitchTip error reporting for the web server (SPEC-operations "Error tracking"). Off unless
 * `SENTRY_DSN` is set. Called once from `instrumentation.ts`.
 */
export function initErrorReporting(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    release: env.WOOLRUS_VERSION || undefined,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    tracesSampleRate: 0,
    initialScope: { tags: { service: "web" } },
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
}

export type ErrorTags = {
  requestId?: string;
  userId?: string;
  stationId?: string;
  orderId?: string;
};

/** Sends an unexpected error with the call's identifying tags; a no-op when reporting is off. */
export function captureServerError(
  err: unknown,
  tags: ErrorTags = {},
  extra?: Record<string, unknown>,
): void {
  const defined = Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined));
  Sentry.captureException(err, { tags: { service: "web", ...defined }, extra });
}

/** Sends what is queued; for tests and deliberate exits. */
export function flushErrors(timeoutMs = 2000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
