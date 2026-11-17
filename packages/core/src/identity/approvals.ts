import type { ApprovalCredential, UnlockTile } from "@woolrus/contracts";
import type { ApprovalKind, Db, DbTx, Prisma, Role, User } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import {
  type Actor,
  can,
  type Permission,
  permissions,
  rolePermissions,
  type UserActor,
} from "../permissions";
import { hashBadgeCode } from "./credentials";
import { checkPin, initials, pinCheckError } from "./station-session";

// A second person's say-so for one action, given in person with a PIN or badge (SPEC-identity A2).
// The credential travels with the action (decision 16): `verifyApprover` runs before the action's
// transaction so a wrong PIN is counted even though the action fails, and `recordApproval` runs
// inside it so the row lives or dies with the action. Neither knows what is being approved.

const notPermitted = () => new AppError("FORBIDDEN", "errors.approval.notPermitted");
const selfApproval = () => new AppError("CONFLICT", "errors.approval.self");

/** Only a person asks for an approval; background jobs never do. */
function requester(actor: Actor): UserActor {
  if (actor.userId === null) throw new AppError("FORBIDDEN", "errors.forbidden");
  return actor;
}

/** The approver must be active and hold `permission` by their roles, never by name (decision 21). */
function mayApprove(user: Pick<User, "active" | "roles">, permission: Permission): boolean {
  return user.active && can({ userId: "", roles: user.roles, stationId: null }, permission);
}

/**
 * Checks the approver's PIN or badge, before and outside the action's transaction. The PIN path is
 * the lock screen's `checkPin`, so both share one lockout (decision 18) and give its errors
 * (`errors.station.badPin` / `pinLocked`); a badge is matched by its SHA-256 (`badBadge`). Then the
 * approver must hold `permission` (`errors.approval.notPermitted`) and must not be the one asking
 * (`errors.approval.self`, decision 20). A personal session never counts (decision 19).
 */
export async function verifyApprover(
  db: Db,
  actor: Actor,
  {
    credential,
    permission,
    now = new Date(),
  }: { credential: ApprovalCredential; permission: Permission; now?: Date },
): Promise<{ approverId: string }> {
  const asker = requester(actor);
  const approver = await credentialUser(db, credential, now);
  if (approver.id === asker.userId) throw selfApproval();
  if (!mayApprove(approver, permission)) throw notPermitted();
  return { approverId: approver.id };
}

async function credentialUser(db: Db, credential: ApprovalCredential, now: Date): Promise<User> {
  if ("badgeCode" in credential) {
    const user = await db.user.findUnique({
      where: { badgeCode: hashBadgeCode(credential.badgeCode) },
    });
    // As on the lock screen, a deactivated user's badge is just an unknown one.
    if (!user?.active) throw new AppError("UNAUTHORIZED", "errors.station.badBadge");
    return user;
  }
  // Its own transaction, committed before we throw, so the attempt counts.
  const check = await db.$transaction((tx) => checkPin(tx, credential.userId, credential.pin, now));
  if (check.kind !== "ok") throw pinCheckError(check);
  return check.user;
}

export type RecordApprovalInput = {
  /** From `verifyApprover`. */
  approverId: string;
  /** The same permission `verifyApprover` checked; re-checked here. */
  permission: Permission;
  kind: ApprovalKind;
  entityType: string;
  entityId: string;
  /** The order the guarded entity belongs to, for its activity feed. */
  orderId?: string;
  reason: string;
  /** What was approved, as the caller describes it (e.g. the tripped checks). */
  details: Prisma.InputJsonValue;
  now?: Date;
};

/**
 * Writes the approval inside the action's transaction, after the action's own checks: re-reads
 * the approver (a deactivation or demotion since `verifyApprover` counts), requires a 1–200
 * character reason (decision 22), writes the `Approval` row and audits `approval.grant` as the
 * requester. Returns the row's id. If the action then fails, the row rolls back with it.
 */
export async function recordApproval(
  tx: DbTx,
  actor: Actor,
  {
    approverId,
    permission,
    kind,
    entityType,
    entityId,
    orderId,
    reason,
    details,
    now = new Date(),
  }: RecordApprovalInput,
): Promise<string> {
  const asker = requester(actor);
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new AppError("BAD_REQUEST", "errors.approval.reasonRequired");
  }
  if (approverId === asker.userId) throw selfApproval();
  // FOR SHARE: a deactivation or role change waits for this action instead of slipping in between.
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${approverId}::uuid FOR SHARE`;
  const approver = await tx.user.findUnique({
    where: { id: approverId },
    select: { active: true, roles: true },
  });
  if (!approver || !mayApprove(approver, permission)) throw notPermitted();

  const { id } = await tx.approval.create({
    data: {
      kind,
      entityType,
      entityId,
      requestedById: asker.userId,
      approvedById: approverId,
      stationId: asker.stationId,
      reason: trimmed,
      details,
      createdAt: now,
    },
    select: { id: true },
  });
  await recordAudit(tx, asker, {
    entityType: "Approval",
    entityId: id,
    action: "approval.grant",
    orderId,
    // `approvedById` like the Approval column, so the timeline can name the approver.
    after: {
      approvalId: id,
      kind,
      approvedById: approverId,
      entityType,
      entityId,
      reason: trimmed,
    },
    at: now,
  });
  return id;
}

/**
 * The approver tiles (`approvers.list`): active users who hold `permission` by their roles and have
 * a PIN, never the caller, sorted by name. Name and initials only, the same exposure as the lock
 * screen's tiles; every tile has a PIN by construction. A badge works for anyone who has one,
 * whether or not they're on a tile. Any person may ask, at a station or a desk.
 */
export async function listApprovers(
  db: Db,
  actor: Actor,
  { permission }: { permission: string },
): Promise<UnlockTile[]> {
  const asker = requester(actor);
  if (!isPermission(permission)) {
    throw new AppError("BAD_REQUEST", "errors.validation", { permission: "errors.field.invalid" });
  }
  const roles = (Object.keys(rolePermissions) as Role[]).filter((role) =>
    rolePermissions[role].includes(permission),
  );
  const users = await db.user.findMany({
    where: {
      active: true,
      pinHash: { not: null },
      roles: { hasSome: roles },
      id: { not: asker.userId },
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return users.map((u) => ({ id: u.id, name: u.name, initials: initials(u.name) }));
}

function isPermission(value: string): value is Permission {
  return (permissions as readonly string[]).includes(value);
}
