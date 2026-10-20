import type { SendTestEmailResult } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { createLogEmailSender, type EmailLogEntry } from "../adapters/email/log";
import { createResendSender, type ResendOptions } from "../adapters/email/resend";
import { EmailError, type EmailSender } from "../adapters/email/sender";
import { AppError } from "../errors";
import type { JobPayloads, queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { getIntegrationConfig } from "../settings/integration";
import { loadSettings } from "../settings/service";
import { renderEmail } from "./emails";

// Sending app email (SPEC-identity "Email"). Other modules enqueue `email.send` jobs; only the
// worker, magic links and the test email call a sender directly.

export type EmailSenderOptions = ResendOptions & { log: (entry: EmailLogEntry) => void };

/** Resend when the sender and key are both set, else the log sender. Built per use: settings change. */
export async function getEmailSender(db: Db, options: EmailSenderOptions): Promise<EmailSender> {
  const { email } = await getIntegrationConfig(db);
  if (!email) return createLogEmailSender(options.log);
  return createResendSender({ apiKey: email.resendApiKey, from: email.from }, options);
}

/** For `/api/health`. Read from the columns, so it never decrypts and works without the key. */
export async function emailStatus(db: Db): Promise<"ok" | "unconfigured"> {
  const row = await loadSettings(db);
  return row.emailFrom && row.resendApiKeyEnc ? "ok" : "unconfigured";
}

/**
 * Settings → Integrations → Send test email: to the admin's own address, inline because they're
 * watching. Failures are a result, like Test connection: the card shows the translated reason.
 */
export async function sendTestEmail(
  db: Db,
  actor: Actor,
  connect: (db: Db) => Promise<EmailSender>,
): Promise<SendTestEmailResult> {
  assertCan(actor, "settings.manage");
  if (actor.userId === null) throw new AppError("FORBIDDEN", "errors.forbidden");
  const user = await db.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { email: true, locale: true },
  });
  try {
    const sender = await connect(db);
    await sender.send({
      to: user.email,
      ...renderEmail("test", {}, user.locale),
      idempotencyKey: `test-email:${crypto.randomUUID()}`,
    });
    return { ok: true, to: user.email, via: sender.kind };
  } catch (error) {
    // A saved key that can't be decrypted is a settings problem worth showing here too.
    if (error instanceof EmailError || error instanceof AppError) {
      return { ok: false, messageKey: error.messageKey };
    }
    throw error;
  }
}

export type EmailJobLogEntry = { template: string; idempotencyKey: string; error: string };

/**
 * The `email.send` job. A permanent failure (bad key, invalid address) is logged and the job
 * finishes, since retrying can't help; anything else throws so pg-boss retries it.
 */
export async function runEmailJob(
  sender: EmailSender,
  { to, template, params, locale, idempotencyKey }: JobPayloads[typeof queues.emailSend],
  { log }: { log: (entry: EmailJobLogEntry) => void },
): Promise<"sent" | "rejected"> {
  try {
    await sender.send({ to, ...renderEmail(template, params, locale), idempotencyKey });
    return "sent";
  } catch (error) {
    if (error instanceof EmailError && error.permanent) {
      log({ template, idempotencyKey, error: error.message });
      return "rejected";
    }
    throw error;
  }
}
