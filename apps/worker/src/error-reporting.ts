import * as Sentry from "@sentry/node";
import { scrubEvent } from "@woolrus/logger";

/**
 * GlitchTip error reporting for the worker (SPEC-operations "Error tracking"). Off unless
 * `SENTRY_DSN` is set. The SDK's default handlers also capture `uncaughtException` and
 * `unhandledRejection`, flush, then let the process exit as before.
 */
export function initErrorReporting(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    release: env.WOOLRUS_VERSION || undefined,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    tracesSampleRate: 0,
    initialScope: { tags: { service: "worker" } },
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
}

/** Sends `err` with the job's identifying tags; a no-op when reporting is off. */
export function captureJobError(
  err: unknown,
  tags: { queue: string; jobId: string; orderId?: string },
): void {
  Sentry.captureException(err, {
    tags: { service: "worker", ...tags },
  });
}

/** For pg-boss `error` events and anything else without a job. */
export function captureError(err: unknown): void {
  Sentry.captureException(err, { tags: { service: "worker" } });
}

/** Sends what is queued; call before a deliberate exit. */
export function flushErrors(timeoutMs = 2000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
