import type { ErrorCode } from "@woolrus/i18n";

// The one way app code sends email (SPEC-identity "Email"). Callers build the message from a
// template (`identity/emails.ts`); the sender only delivers it.

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The same key never sends twice (Resend keeps it 24 h), so a retried job can't double-send. */
  idempotencyKey: string;
};

export interface EmailSender {
  /** `log` when Resend isn't configured: the message goes to the server log, not an inbox. */
  readonly kind: "resend" | "log";
  send(message: EmailMessage): Promise<void>;
}

export const emailErrorKinds = ["unauthorized", "rejected", "unavailable"] as const;
export type EmailErrorKind = (typeof emailErrorKinds)[number];

/**
 * A send that failed. `unavailable` (429, 5xx, network) may work later, so jobs retry it; the
 * others are permanent. `detail` names the status and Resend's error name, never the key, the
 * recipient or Resend's message text (which can echo the request).
 */
export class EmailError extends Error {
  readonly messageKey: ErrorCode;
  readonly permanent: boolean;

  constructor(
    readonly kind: EmailErrorKind,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "EmailError";
    this.messageKey = `errors.email.${kind}`;
    this.permanent = kind !== "unavailable";
  }
}
