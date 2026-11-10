import {
  type AddUserEmailInput,
  type CreateStationUserInput,
  Pin,
  type UpdateUserRolesInput,
  USER_LIST_PAGE_MAX,
  type UserListInput,
  type UserListPage,
  type UserSummary,
} from "@woolrus/contracts";
import { type Db, type DbTx, Prisma, type Role } from "@woolrus/db";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { hashBadgeCode, hashPin, newBadgeCode } from "./credentials";
import { openInvitation } from "./sign-in";
import {
  isStationOnly,
  publicEmail,
  stationOnlyEmailFilter,
  stationOnlyPlaceholder,
} from "./station-only";

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
    email: publicEmail(user.email),
    stationOnly: isStationOnly(user.email),
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

/** Name order, a page at a time, optionally narrowed to a name or email fragment. */
export async function listUsers(
  db: Db,
  actor: Actor,
  input: UserListInput = {},
): Promise<UserListPage> {
  assertCan(actor, "user.manage");
  const page = Math.max(1, Math.trunc(Number(input.page ?? 1)));
  const pageSize = Math.min(
    USER_LIST_PAGE_MAX,
    Math.max(1, Math.trunc(Number(input.pageSize ?? 50))),
  );
  const search = input.search?.trim();
  const where: Prisma.UserWhereInput = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          {
            email: { contains: search, mode: "insensitive" },
            NOT: { email: stationOnlyEmailFilter },
          },
        ],
      }
    : {};
  const [users, total] = await db.$transaction([
    db.user.findMany({
      where,
      select: summarySelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({ where }),
  ]);
  return { users: users.map(toUserSummary), total, page, pageSize };
}

const stationOnlyAdmin = () => new AppError("BAD_REQUEST", "errors.users.stationOnlyAdmin");

/** Validates as the contract does, so core doesn't rely on the route having parsed the input. */
function parsePin(pin: string): void {
  const parsed = Pin.safeParse(pin);
  if (!parsed.success) {
    const key =
      parsed.error.issues[0]?.message === "errors.users.pinWeak" ? "pinWeak" : "pinFormat";
    throw new AppError("BAD_REQUEST", "errors.validation", { pin: `errors.users.${key}` });
  }
}

/**
 * A worker with no email (SPEC-identity amendment 1): a name, roles and a PIN, unlocking stations
 * only. Never Admin (decision 10): a 6-digit PIN would then be the only credential for full admin
 * powers. The PIN is required (decision 11) and hashed before the transaction, as in `setPin`.
 * Names needn't be unique (decision 13); the dialog warns about duplicates.
 */
export async function createStationUser(
  db: Db,
  actor: Actor,
  { idempotencyKey, ...input }: CreateStationUserInput,
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new AppError("BAD_REQUEST", "errors.validation", {
      name: name.length ? "errors.field.tooBig" : "errors.field.required",
    });
  }
  const roles = [...new Set<Role>(input.roles)];
  if (roles.length === 0) throw new AppError("BAD_REQUEST", "errors.users.rolesRequired");
  if (roles.includes("ADMIN")) throw stationOnlyAdmin();
  parsePin(input.pin);
  const pinHash = await hashPin(input.pin);
  // Only the id is stored for replays: the stored JSON would turn the dates into strings.
  const { id } = await db.$transaction((tx) =>
    withIdempotency(tx, idempotencyKey, "users.createStationUser", actor, async () => {
      const user = await tx.user.create({
        data: {
          name,
          email: stationOnlyPlaceholder(),
          emailVerified: false,
          active: true,
          roles,
          pinHash,
        },
        select: { id: true },
      });
      await recordAudit(tx, actor, {
        entityType: "User",
        entityId: user.id,
        action: "user.create",
        after: { stationOnly: true, roles },
      });
      return { id: user.id };
    }),
  );
  return toUserSummary(await db.user.findUniqueOrThrow({ where: { id }, select: summarySelect }));
}

/**
 * Gives a station-only user a real email (SPEC-identity amendment 1, decision 14), so they become a
 * regular user with the same id, roles, PIN, badge and history. `emailVerified` is set true (decision
 * 15): Better Auth 1.7.8 fails the first magic link of an unverified existing user, and a
 * station-only user has no accounts or sessions for that check to revoke. One address never leads to two accounts, so an address
 * another user has, or one with an open invitation, is refused. The `accountEnabled` email is
 * queued in the same transaction, so it exists only if the change commits. English, like
 * invitations (decision 8).
 */
export async function addUserEmail(
  db: Db,
  actor: Actor,
  { idempotencyKey, id, ...input }: AddUserEmailInput,
  { appUrl }: { appUrl: string },
): Promise<UserSummary> {
  assertCan(actor, "user.manage");
  // The contract already lowercases; core doesn't rely on it.
  const email = input.email.trim().toLowerCase();
  if (isStationOnly(email)) throw new AppError("BAD_REQUEST", "errors.invitations.reservedEmail");
  try {
    await db.$transaction((tx) =>
      withIdempotency(tx, idempotencyKey, "users.addEmail", actor, async () => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
        const user = await tx.user.findUnique({
          where: { id },
          select: { email: true, active: true },
        });
        if (!user) throw notFound();
        if (!isStationOnly(user.email)) {
          throw new AppError("CONFLICT", "errors.users.notStationOnly");
        }
        // Their sign-in email would lead nowhere: a deactivated user can't sign in, and
        // reactivating doesn't resend it. Reactivate first.
        if (!user.active) throw new AppError("CONFLICT", "errors.users.addEmailInactive");
        if (await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })) {
          throw new AppError("CONFLICT", "errors.users.alreadyExists");
        }
        if (await openInvitation(tx, email)) {
          throw new AppError("CONFLICT", "errors.users.invitationPending");
        }
        await tx.user.update({ where: { id }, data: { email, emailVerified: true } });
        const admin = actor.userId
          ? (await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))
              ?.name
          : undefined;
        await enqueue(tx, queues.emailSend, {
          to: email,
          template: "accountEnabled",
          params: {
            admin: admin ?? "Woolrus",
            url: `${appUrl}/sign-in?email=${encodeURIComponent(email)}`,
          },
          locale: "en",
          idempotencyKey: crypto.randomUUID(),
        });
        await recordAudit(tx, actor, {
          entityType: "User",
          entityId: id,
          action: "user.email.add",
          after: { email },
        });
        return { id };
      }),
    );
  } catch (error) {
    // Someone took the address between the check and the update (a sign-up or another admin).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("CONFLICT", "errors.users.alreadyExists");
    }
    throw error;
  }
  return toUserSummary(await db.user.findUniqueOrThrow({ where: { id }, select: summarySelect }));
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
    if (roles.includes("ADMIN") && isStationOnly(user.email)) throw stationOnlyAdmin();
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
  parsePin(pin);
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
