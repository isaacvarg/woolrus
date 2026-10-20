import type { Db, DbTx } from "@woolrus/db";
import type { Locale } from "@woolrus/i18n";
import type { EmailSender } from "../adapters/email/sender";
import { renderEmail } from "./emails";

// Who may get an account (NFR-SEC-02, SRS §7.1 #3). Better Auth's user-create hooks in the web app
// call these, so the rule lives in core and is tested here.

/** An invitation that can still be accepted: not accepted, not revoked, not expired. */
export async function openInvitation(db: Db | DbTx, email: string, now = new Date()) {
  return db.invitation.findFirst({
    where: {
      email: email.toLowerCase(),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
}

const isAdminEmail = (email: string, adminEmails: readonly string[]) =>
  adminEmails.includes(email.toLowerCase());

/** Invite-only: an open invitation, or an `ADMIN_EMAILS` address bootstrapping an admin. */
export async function mayCreateAccount(
  db: Db,
  email: string,
  adminEmails: readonly string[],
): Promise<boolean> {
  return isAdminEmail(email, adminEmails) || (await openInvitation(db, email)) !== null;
}

/** After the account exists: copy the invited roles exactly, and mark the invitation accepted. */
export async function acceptInvitation(
  db: Db,
  user: { id: string; email: string },
  adminEmails: readonly string[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    const invitation = await openInvitation(tx, user.email);
    const roles = isAdminEmail(user.email, adminEmails)
      ? ["ADMIN" as const]
      : (invitation?.roles ?? []);
    await tx.user.update({ where: { id: user.id }, data: { roles } });
    if (invitation) {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
    }
  });
}

export type MagicLinkLog = {
  info: (entry: { email: string }, message: string) => void;
  error: (entry: { email: string; err: unknown }, message: string) => void;
};

/**
 * Better Auth's `sendMagicLink`. Sends only to an active user, an open invitation or an
 * `ADMIN_EMAILS` address, so our email account can't be used to mail strangers. Inline, not a job:
 * the person is waiting, and the link must never sit in the job table. The result is for logs and
 * tests only: the caller answers "check your email" whatever happens, so the page can't be used to
 * find out who has an account.
 */
export async function sendMagicLink(
  db: Db,
  { email, url, fallbackLocale }: { email: string; url: string; fallbackLocale: Locale },
  {
    adminEmails,
    sender,
    log,
  }: {
    adminEmails: readonly string[];
    sender: (db: Db) => Promise<EmailSender>;
    log: MagicLinkLog;
  },
): Promise<"sent" | "skipped" | "failed"> {
  const address = email.trim().toLowerCase();
  const user = await db.user.findFirst({
    where: { email: { equals: address, mode: "insensitive" } },
    select: { active: true, locale: true },
  });
  const allowed = user
    ? user.active
    : isAdminEmail(address, adminEmails) || (await openInvitation(db, address)) !== null;
  if (!allowed) {
    log.info({ email: address }, "magic link not sent: no active user or open invitation");
    return "skipped";
  }
  try {
    await (await sender(db)).send({
      to: email,
      ...renderEmail("magicLink", { url }, user?.locale ?? fallbackLocale),
      idempotencyKey: `magic-link:${crypto.randomUUID()}`,
    });
    return "sent";
  } catch (err) {
    log.error({ email: address, err }, "magic link email failed");
    return "failed";
  }
}
