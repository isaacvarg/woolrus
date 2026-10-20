import type { CreateInvitationInput, Invitation, InvitationStatus } from "@woolrus/contracts";
import { type Db, type DbTx, Prisma } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";

const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const select = {
  id: true,
  email: true,
  roles: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { name: true } },
} satisfies Prisma.InvitationSelect;

type InvitationRow = Prisma.InvitationGetPayload<{ select: typeof select }>;

function statusOf(row: InvitationRow, now: Date): InvitationStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt > now ? "pending" : "expired";
}

function toInvitation(row: InvitationRow, now = new Date()): Invitation {
  return {
    id: row.id,
    email: row.email,
    roles: row.roles,
    status: statusOf(row, now),
    invitedByName: row.invitedBy?.name ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Queues the invitation email in `tx`, so it exists only if the invitation commits. English only
 * (SPEC-identity decision 8). The link pre-fills the sign-in page's magic-link field.
 */
async function enqueueInvitationEmail(
  tx: DbTx,
  actor: Actor,
  invitation: { email: string; roles: readonly InvitationRow["roles"][number][] },
  appUrl: string,
) {
  const inviter = actor.userId
    ? (await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name
    : undefined;
  await enqueue(tx, queues.emailSend, {
    to: invitation.email,
    template: "invitation",
    params: {
      inviter: inviter ?? "Woolrus",
      roles: invitation.roles.map((role) => messages.en.users.role[role]).join(", "),
      url: `${appUrl}/sign-in?email=${encodeURIComponent(invitation.email)}`,
    },
    locale: "en",
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function listInvitations(db: Db, actor: Actor): Promise<Invitation[]> {
  assertCan(actor, "user.manage");
  const rows = await db.invitation.findMany({ select, orderBy: { createdAt: "desc" } });
  const now = new Date();
  return rows.map((row) => toInvitation(row, now));
}

/**
 * The email column is unique, so re-inviting a revoked or expired (or orphaned accepted) address
 * reuses its row with everything reset. A pending one is refused: resend or revoke it instead.
 */
export async function createInvitation(
  db: Db,
  actor: Actor,
  { idempotencyKey, ...input }: CreateInvitationInput,
  { appUrl }: { appUrl: string },
): Promise<Invitation> {
  assertCan(actor, "user.manage");
  // The contract already does both; core doesn't rely on it.
  const email = input.email.trim().toLowerCase();
  const roles = [...new Set(input.roles)];
  if (roles.length === 0) throw new AppError("BAD_REQUEST", "errors.users.rolesRequired");
  try {
    // Only the id is stored for replays: the stored JSON would turn the dates into strings.
    const { id } = await db.$transaction((tx) =>
      withIdempotency(tx, idempotencyKey, "invitations.create", actor, async () => {
        if (await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })) {
          throw new AppError("CONFLICT", "errors.users.alreadyExists");
        }
        const existing = await tx.invitation.findUnique({ where: { email }, select });
        if (existing && statusOf(existing, new Date()) === "pending") {
          throw new AppError("CONFLICT", "errors.invitations.pending");
        }
        const data = {
          roles,
          invitedById: actor.userId,
          expiresAt: new Date(Date.now() + VALID_FOR_MS),
          acceptedAt: null,
          revokedAt: null,
        };
        const invitation = existing
          ? await tx.invitation.update({ where: { id: existing.id }, data, select })
          : await tx.invitation.create({ data: { email, ...data }, select });
        await enqueueInvitationEmail(tx, actor, invitation, appUrl);
        await recordAudit(tx, actor, {
          entityType: "Invitation",
          entityId: invitation.id,
          action: "invitation.create",
          after: { email, roles, expiresAt: invitation.expiresAt.toISOString() },
        });
        return { id: invitation.id };
      }),
    );
    return toInvitation(await db.invitation.findUniqueOrThrow({ where: { id }, select }));
  } catch (error) {
    // Two admins inviting the same new address at once: the second hits the unique email.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("CONFLICT", "errors.invitations.pending");
    }
    throw error;
  }
}

/** Pending or expired invitations only: extends the expiry 7 days from now and emails again. */
export async function resendInvitation(
  db: Db,
  actor: Actor,
  { id }: { id: string },
  { appUrl }: { appUrl: string },
): Promise<Invitation> {
  assertCan(actor, "user.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.invitation.findUnique({ where: { id }, select });
    if (!existing) throw notFound();
    if (existing.acceptedAt || existing.revokedAt) {
      throw new AppError("CONFLICT", "errors.invitations.notOpen");
    }
    const invitation = await tx.invitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() + VALID_FOR_MS) },
      select,
    });
    await enqueueInvitationEmail(tx, actor, invitation, appUrl);
    await recordAudit(tx, actor, {
      entityType: "Invitation",
      entityId: id,
      action: "invitation.resend",
      after: { expiresAt: invitation.expiresAt.toISOString() },
    });
    return toInvitation(invitation);
  });
}

/** Idempotent. The sign-up hook then refuses the address (see `mayCreateAccount`). */
export async function revokeInvitation(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<Invitation> {
  assertCan(actor, "user.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.invitation.findUnique({ where: { id }, select });
    if (!existing) throw notFound();
    if (existing.revokedAt) return toInvitation(existing);
    if (existing.acceptedAt) throw new AppError("CONFLICT", "errors.invitations.notOpen");
    const invitation = await tx.invitation.update({
      where: { id },
      data: { revokedAt: new Date() },
      select,
    });
    await recordAudit(tx, actor, {
      entityType: "Invitation",
      entityId: id,
      action: "invitation.revoke",
    });
    return toInvitation(invitation);
  });
}
