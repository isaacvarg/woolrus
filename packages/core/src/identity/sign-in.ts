import type { Db, DbTx } from "@woolrus/db";

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
