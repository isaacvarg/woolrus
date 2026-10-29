import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@woolrus/logger";

export type BrowserErrorConfig = {
  dsn?: string;
  userId?: string;
  release?: string;
  environment?: string;
};

/**
 * Starts the browser SDK (SPEC-operations "Error tracking"). Off without a DSN. The DSN is read by
 * the root layout at runtime; events go through `POST /api/errors`, not to GlitchTip directly.
 */
export function initBrowserErrorReporting(config: BrowserErrorConfig): boolean {
  if (!config.dsn) return false;
  Sentry.init({
    dsn: config.dsn,
    tunnel: "/api/errors",
    release: config.release || undefined,
    environment: config.environment || undefined,
    tracesSampleRate: 0,
    initialScope: {
      tags: { service: "web-browser", ...(config.userId ? { userId: config.userId } : {}) },
    },
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
}

/** Sends a render error caught by an error boundary; a no-op when reporting is off. */
export function captureRenderError(error: Error & { digest?: string }): void {
  Sentry.captureException(error, { tags: error.digest ? { digest: error.digest } : undefined });
}
