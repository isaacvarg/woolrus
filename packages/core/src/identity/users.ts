import { Pin, type UpdateUserRolesInput, type UserSummary } from "@woolrus/contracts";
import type { Db, DbTx, Prisma, Role } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { hashBadgeCode, hashPin, newBadgeCode } from "./credentials";

const summarySelect = {
  id: true,
  name: true,
  email: true,
  roles: true,
  active: true,
  pinHash: true,
  badgeCode: true,
  pinLockedUntil: true,
  sessions: { select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
  stationActivations: { select: { startedAt: true }, orderBy: { startedAt: "desc" }, take: 1 },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof summarySelect }>;

/** Only flags leave this function: never `pinHash` or `badgeCode` (SPEC-identity, no secrets out). */
function toUserSummary(user: UserRow): UserSummary {
  const times = [user.sessions[0]?.updatedAt, user.stationActivations[0]?.startedAt].filter(
    (t): t is Date => t !== undefined,
  );
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    active: user.active,
    hasPin: user.pinHash !== null,
    hasBadge: user.badgeCode !== null,
    pinLockedUntil: user.pinLockedUntil,
    lastActiveAt: times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null,
  };
}

async function summary(tx: DbTx, id: string): Promise<UserSummary> {
  return toUserSummary(await tx.user.findUniqueOrThrow({ where: { id }, select: summarySelect }));
}

/**
 * Locks the target and every active Admin, so two admins demoting each other at once can't both
 * pass the last-admin check: the second waits, then re-reads the Admin set without the first.
 * NO KEY UPDATE, not UPDATE: it doesn't block sessions and audit rows referencing these users.
 */
async function lockForUserChange(tx: DbTx, id: string) {
  await tx.$queryRaw`
    SELECT id FROM users WHERE id = ${id}::uuid OR (active AND 'ADMIN' = ANY(roles)) FOR NO KEY UPDATE`;
  const user = await tx.user.findUnique({ where: { id } });
  if (!user) throw notFound();
  return user;
}

/** Refuses a change that takes `id` out of the active Admins when no other active Admin is left. */
async function assertNotLastAdmin(tx: DbTx, id: string): Promise<void> {
  const others = await tx.user.count({
    where: { id: { not: id }, active: true, roles: { has: "ADMIN" } },
  });
  if (others === 0) throw new AppError("CONFLICT", "errors.users.lastAdmin");
}

export async function listUsers(db: Db, actor: Actor): Promise<UserSummary[]> {
  assertCan(actor, "user.manage");
  const users = await db.user.findMany({ select: summarySelect, orderBy: { name: "asc" } });
  return users.map(toUserSummary);
}

export async function updateUserRoles(
  db: Db,
  actor: Actor,
  { id, roles: requested }: UpdateUserRolesInput,
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  const roles = [...new Set<Role>(requested)];
  if (roles.length === 0) throw new AppError("BAD_REQUEST", "errors.users.rolesRequired");
  return db.$transaction(async (tx) => {
    const user = await lockForUserChange(tx, id);
    const losesAdmin = user.roles.includes("ADMIN") && !roles.includes("ADMIN");
    if (losesAdmin && id === actor.userId) throw new AppError("CONFLICT", "errors.users.self");
    if (losesAdmin && user.active) await assertNotLastAdmin(tx, id);

    await tx.user.update({ where: { id }, data: { roles } });
    await recordAudit(tx, actor, {
      entityType: "User",
      entityId: id,
      action: "user.roles.update",
      before: { roles: user.roles },
      after: { roles },
    });
    return summary(tx, id);
  });
}

/**
 * Signs the user out everywhere at once: deleting their Better Auth sessions kills both the cookie
 * and any bearer token (the same session row), and their station activations end.
 */
export async function deactivateUser(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  if (id === actor.userId) throw new AppError("CONFLICT", "errors.users.self");
  return db.$transaction(async (tx) => {
    const user = await lockForUserChange(tx, id);
    if (!user.active) return summary(tx, id);
    if (user.roles.includes("ADMIN")) await assertNotLastAdmin(tx, id);

    await tx.user.update({ where: { id }, data: { active: false } });
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.stationActivation.updateMany({
      where: { userId: id, endedAt: null },
      data: { endedAt: new Date(), endReason: "MANUAL" },
    });
    await recordAudit(tx, actor, { entityType: "User", entityId: id, action: "user.deactivate" });
    return summary(tx, id);
  });
}

export async function reactivateUser(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  return db.$transaction(async (tx) => {
    const user = await lockForUserChange(tx, id);
    if (user.active) return summary(tx, id);
    await tx.user.update({ where: { id }, data: { active: true } });
    await recordAudit(tx, actor, { entityType: "User", entityId: id, action: "user.reactivate" });
    return summary(tx, id);
  });
}

/**
 * Sets the PIN and lifts any lockout. The PIN never reaches the audit row or the response.
 * Hashed before the transaction: scrypt is deliberately slow and shouldn't hold row locks.
 */
export async function setPin(
  db: Db,
  actor: Actor,
  { id, pin }: { id: string; pin: string },
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  const parsed = Pin.safeParse(pin);
  if (!parsed.success) {
    const key =
      parsed.error.issues[0]?.message === "errors.users.pinWeak" ? "pinWeak" : "pinFormat";
    throw new AppError("BAD_REQUEST", "errors.validation", { pin: `errors.users.${key}` });
  }
  const pinHash = await hashPin(pin);
  return db.$transaction(async (tx) => {
    await lockForUserChange(tx, id);
    await tx.user.update({
      where: { id },
      data: { pinHash, pinFailedAttempts: 0, pinLockedUntil: null },
    });
    await recordAudit(tx, actor, { entityType: "User", entityId: id, action: "user.pin.set" });
    return summary(tx, id);
  });
}

export async function clearPin(db: Db, actor: Actor, { id }: { id: string }): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  return db.$transaction(async (tx) => {
    await lockForUserChange(tx, id);
    await tx.user.update({
      where: { id },
      data: { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null },
    });
    await recordAudit(tx, actor, { entityType: "User", entityId: id, action: "user.pin.clear" });
    return summary(tx, id);
  });
}

/**
 * A new badge, replacing any old one. Only the code's SHA-256 is stored, so the code in the
 * result is the only time anyone sees it: the admin prints it now or issues another.
 */
export async function issueBadge(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<{ user: UserSummary; code: string }> {
  assertCan(actor, "user.manage");
  const code = newBadgeCode();
  return db.$transaction(async (tx) => {
    await lockForUserChange(tx, id);
    await tx.user.update({
      where: { id },
      data: { badgeCode: hashBadgeCode(code), badgeIssuedAt: new Date() },
    });
    await recordAudit(tx, actor, { entityType: "User", entityId: id, action: "user.badge.issue" });
    return { user: await summary(tx, id), code };
  });
}

export async function revokeBadge(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  return db.$transaction(async (tx) => {
    await lockForUserChange(tx, id);
    await tx.user.update({ where: { id }, data: { badgeCode: null, badgeIssuedAt: null } });
    await recordAudit(tx, actor, { entityType: "User", entityId: id, action: "user.badge.revoke" });
    return summary(tx, id);
  });
}
