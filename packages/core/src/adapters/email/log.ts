import type { EmailSender } from "./sender";

/** What the log sender writes. `text` (where a dev sign-in link would be) only outside production. */
export type EmailLogEntry = { to: string; subject: string; text?: string };

/**
 * Stands in for Resend when it isn't configured: dev works with no account, and health reports
 * email as `unconfigured`, which blocks go-live.
 */
export function createLogEmailSender(log: (entry: EmailLogEntry) => void): EmailSender {
  return {
    kind: "log",
    async send({ to, subject, text }) {
      log(process.env.NODE_ENV === "production" ? { to, subject } : { to, subject, text });
    },
  };
}
