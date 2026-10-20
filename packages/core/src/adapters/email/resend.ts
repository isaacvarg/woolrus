import { EmailError, type EmailMessage, type EmailSender } from "./sender";

export type ResendConfig = { apiKey: string; from: string };

export type ResendOptions = { fetch?: typeof fetch; timeoutMs?: number };

const ENDPOINT = "https://api.resend.com/emails";

/** The first request with this key hasn't finished: retrying later gets its result. */
const IN_FLIGHT = "concurrent_idempotent_requests";

/** Resend's error body (`{ statusCode, name, message }`); only `name` is kept. */
async function errorName(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body.name === "string" ? body.name : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Resend's HTTP API over plain `fetch` (decided in SPEC-identity: no SDK). It doesn't retry:
 * an `unavailable` error goes back to the `email.send` job, and pg-boss retries it with backoff.
 */
export function createResendSender(config: ResendConfig, options: ResendOptions = {}): EmailSender {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    kind: "resend",
    async send({ to, subject, html, text, idempotencyKey }: EmailMessage) {
      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ from: config.from, to: [to], subject, html, text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        throw new EmailError("unavailable", timedOut ? "timeout" : "network");
      }
      if (response.ok) return;

      const status = response.status;
      const name = await errorName(response);
      const detail = `${status} ${name}`;
      if (status === 429 || status >= 500 || (status === 409 && name === IN_FLIGHT)) {
        throw new EmailError("unavailable", detail, status);
      }
      throw new EmailError(
        status === 401 || status === 403 ? "unauthorized" : "rejected",
        detail,
        status,
      );
    },
  };
}
