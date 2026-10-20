import { createHash, randomBytes } from "node:crypto";
import {
  type RegisterStationInput,
  type RenameStationInput,
  StationName,
  type StationStatus,
  type StationSummary,
  type StationUnlocked,
  type UnlockBadgeInput,
  type UnlockPinInput,
} from "@woolrus/contracts";
import {
  type Db,
  type DbTx,
  Prisma,
  type Station,
  type StationUnlockMethod,
  type User,
} from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan, type UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { hashBadgeCode, hashPin, verifyPin } from "./credentials";

// Shared floor tablets (SPEC-identity "Stations"). A station holds a long-lived random token in an
// httpOnly cookie; only its SHA-256 is stored, so a database read can't impersonate a station.

export const hashStationToken = (token: string) => createHash("sha256").update(token).digest("hex");

const select = {
  id: true,
  name: true,
  active: true,
  lastSeenAt: true,
  createdAt: true,
  activations: {
    where: { endedAt: null },
    select: { user: { select: { name: true } } },
    orderBy: { startedAt: "desc" },
    take: 1,
  },
} satisfies Prisma.StationSelect;

type StationRow = Prisma.StationGetPayload<{ select: typeof select }>;

function toSummary(row: StationRow): StationSummary {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    currentUserName: row.activations[0]?.user.name ?? null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

async function summary(tx: DbTx, id: string): Promise<StationSummary> {
  return toSummary(await tx.station.findUniqueOrThrow({ where: { id }, select }));
}

/** Validated here as well as in the contract: core is also called without one. */
function parseName(name: string): string {
  const parsed = StationName.safeParse(name);
  if (parsed.success) return parsed.data;
  const key = parsed.error.issues[0]?.message;
  throw new AppError("BAD_REQUEST", "errors.validation", {
    name: key === "errors.stations.nameTooLong" ? key : "errors.field.required",
  });
}

function nameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError("CONFLICT", "errors.stations.nameTaken", {
      name: "errors.stations.nameTaken",
    });
  }
  throw error;
}

export async function listStations(db: Db, actor: Actor): Promise<StationSummary[]> {
  assertCan(actor, "station.manage");
  const rows = await db.station.findMany({
    select,
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return rows.map(toSummary);
}

/**
 * Makes the caller's device a station. Returns the token for the caller to put in the station
 * cookie; it is never stored, logged, audited or sent in a response body. Only from a personal
 * session: the web layer then signs that session out.
 */
export async function registerStation(
  db: Db,
  actor: Actor,
  input: RegisterStationInput,
): Promise<{ station: StationSummary; token: string }> {
  assertCan(actor, "station.manage");
  if (actor.stationId !== null) throw new AppError("FORBIDDEN", "errors.stations.personalOnly");
  const name = parseName(input.name);
  const token = randomBytes(32).toString("base64url");
  try {
    return await db.$transaction(async (tx) => {
      const { id } = await tx.station.create({
        data: { name, tokenHash: hashStationToken(token), registeredById: actor.userId },
      });
      await recordAudit(tx, actor, {
        entityType: "Station",
        entityId: id,
        action: "station.register",
        after: { name },
      });
      return { station: await summary(tx, id), token };
    });
  } catch (error) {
    nameTaken(error);
  }
}

export async function renameStation(
  db: Db,
  actor: Actor,
  input: RenameStationInput,
): Promise<StationSummary> {
  assertCan(actor, "station.manage");
  const name = parseName(input.name);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.station.findUnique({ where: { id: input.id } });
      if (!existing) throw notFound();
      await tx.station.update({ where: { id: input.id }, data: { name } });
      await recordAudit(tx, actor, {
        entityType: "Station",
        entityId: input.id,
        action: "station.rename",
        before: { name: existing.name },
        after: { name },
      });
      return summary(tx, input.id);
    });
  } catch (error) {
    nameTaken(error);
  }
}

/**
 * Idempotent. Whoever is unlocked on it is locked out (`STATION_REVOKED`), and the device's next
 * request finds no station, so it forgets its cookie and shows the sign-in page.
 */
export async function revokeStation(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<StationSummary> {
  assertCan(actor, "station.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.station.findUnique({ where: { id } });
    if (!existing) throw notFound();
    if (!existing.active) return summary(tx, id);
    await tx.station.update({ where: { id }, data: { active: false } });
    await tx.stationActivation.updateMany({
      where: { stationId: id, endedAt: null },
      data: { endedAt: new Date(), endReason: "STATION_REVOKED" },
    });
    await recordAudit(tx, actor, { entityType: "Station", entityId: id, action: "station.revoke" });
    return summary(tx, id);
  });
}

/** The active station holding `token`, or null (unknown, or revoked). */
export async function findStationByToken(db: Db, token: string): Promise<Station | null> {
  return db.station.findFirst({ where: { tokenHash: hashStationToken(token), active: true } });
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * For the station device itself (`station.status`). The tiles carry a name and initials only:
 * enough to find yourself, nothing to sign in with.
 */
export async function stationStatus(
  db: Db,
  station: Station,
  now: Date = new Date(),
): Promise<StationStatus> {
  const [users, active] = await Promise.all([
    db.user.findMany({
      where: { active: true, pinHash: { not: null } },
      select: {
        id: true,
        name: true,
        stationActivations: {
          where: { stationId: station.id },
          select: { startedAt: true },
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
    // Through stationActor, so a turn that went idle ends here too, not just on the next request.
    stationActor(db, station, now),
  ]);
  const lastHere = (u: (typeof users)[number]) => u.stationActivations[0]?.startedAt.getTime() ?? 0;
  // Stable sort: people who never used this station stay in name order after the rest.
  const tiles = users
    .toSorted((a, b) => lastHere(b) - lastHere(a))
    .map((u) => ({ id: u.id, name: u.name, initials: initials(u.name) }));
  return {
    id: station.id,
    name: station.name,
    activeUserName: active?.user.name ?? null,
    tiles,
  };
}

function openActivation(db: Db | DbTx, stationId: string) {
  return db.stationActivation.findFirst({
    where: { stationId, endedAt: null },
    include: { user: true },
    orderBy: { startedAt: "desc" },
  });
}

const MINUTE = 60_000;

/** When an activation locks itself: `Settings.stationIdleLockMinutes` after the last input. */
async function idleDeadline(db: Db | DbTx, lastActivityAt: Date): Promise<Date> {
  const { stationIdleLockMinutes } = await loadSettings(db);
  return new Date(lastActivityAt.getTime() + stationIdleLockMinutes * MINUTE);
}

/** Ends an activation that went idle, as of its deadline. A no-op if something else ended it. */
async function endIdle(db: Db | DbTx, id: string, deadline: Date): Promise<void> {
  await db.stationActivation.updateMany({
    where: { id, endedAt: null },
    data: { endedAt: deadline, endReason: "IDLE" },
  });
}

/**
 * Who the station is acting as: its open activation's user, if still active. Null means locked.
 * Permissions are exactly the user's roles; the station only adds where (decision 4).
 *
 * Idle lock is enforced here, lazily (like claims; no job): the first request past the deadline
 * ends the activation (`IDLE`). Resolving the actor never extends it: only `touchStation` does, so
 * a tablet left on a page with background refetches still locks.
 */
export async function stationActor(
  db: Db,
  station: Station,
  now: Date = new Date(),
): Promise<{ user: User; actor: UserActor; idleLockAt: Date } | null> {
  const activation = await openActivation(db, station.id);
  if (!activation?.user.active) return null;
  const idleLockAt = await idleDeadline(db, activation.lastActivityAt);
  if (idleLockAt < now) {
    await endIdle(db, activation.id, idleLockAt);
    return null;
  }
  // At most once a minute, so every request doesn't write.
  await db.station.updateMany({
    where: {
      id: station.id,
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: new Date(now.getTime() - MINUTE) } }],
    },
    data: { lastSeenAt: now },
  });
  const { user } = activation;
  return {
    user,
    actor: { userId: user.id, roles: user.roles, stationId: station.id },
    idleLockAt,
  };
}

/**
 * Pointer, key or scan input on the station (`station.touch`): pushes the idle deadline out. Too
 * late is too late: an activation already past its deadline ends instead of being revived.
 */
export async function touchStation(
  db: Db,
  actor: Actor,
  now: Date = new Date(),
): Promise<{ idleLockAt: Date }> {
  const { stationId } = actor;
  if (stationId === null) throw new AppError("FORBIDDEN", "errors.station.notStation");
  const outcome = await db.$transaction(async (tx) => {
    const activation = await tx.stationActivation.findFirst({
      where: { stationId, userId: actor.userId, endedAt: null },
    });
    if (!activation) return null;
    const deadline = await idleDeadline(tx, activation.lastActivityAt);
    if (deadline < now) {
      await endIdle(tx, activation.id, deadline);
      return null;
    }
    await tx.stationActivation.update({
      where: { id: activation.id },
      data: { lastActivityAt: now },
    });
    return { idleLockAt: await idleDeadline(tx, now) };
  });
  // After the commit, so the IDLE end sticks.
  if (!outcome) throw new AppError("UNAUTHORIZED", "errors.station.locked");
  return outcome;
}

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

// Checked against when there is no PIN to check, so an unknown user takes as long to refuse as a
// wrong PIN and the tiles can't be used to probe who has one.
let decoy: Promise<string> | undefined;
const decoyPinHash = () => {
  decoy ??= hashPin("000000");
  return decoy;
};

const badPin = () => new AppError("UNAUTHORIZED", "errors.station.badPin");

/**
 * Tap your name, enter your PIN (SPEC-identity "Unlock with PIN"). 5 wrong PINs in a row lock that
 * user's PIN for 15 minutes on every station. The counter must survive the refusal, so the
 * transaction returns the outcome and the error is thrown after it commits.
 */
export async function unlockWithPin(
  db: Db,
  station: Station,
  { userId, pin }: UnlockPinInput,
  now: Date = new Date(),
): Promise<StationUnlocked> {
  const outcome = await db.$transaction(async (tx) => {
    // Serializes attempts for this user, so parallel guesses can't each see a count below 5.
    // NO KEY: a plain FOR UPDATE would also block inserts that reference the user (sessions).
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user?.active || !user.pinHash) {
      await verifyPin(pin, await decoyPinHash());
      return { kind: "bad" } as const;
    }
    if (user.pinLockedUntil && user.pinLockedUntil > now) {
      return { kind: "locked", until: user.pinLockedUntil } as const;
    }
    if (!(await verifyPin(pin, user.pinHash))) {
      const attempts = user.pinFailedAttempts + 1;
      if (attempts < PIN_MAX_ATTEMPTS) {
        await tx.user.update({ where: { id: userId }, data: { pinFailedAttempts: attempts } });
        return { kind: "bad" } as const;
      }
      const until = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000);
      await tx.user.update({
        where: { id: userId },
        data: { pinFailedAttempts: 0, pinLockedUntil: until },
      });
      return { kind: "locked", until } as const;
    }
    if (user.pinFailedAttempts > 0 || user.pinLockedUntil) {
      await tx.user.update({
        where: { id: userId },
        data: { pinFailedAttempts: 0, pinLockedUntil: null },
      });
    }
    await activate(tx, station, user, "PIN", now);
    return { kind: "ok", userName: user.name } as const;
  });
  if (outcome.kind === "bad") throw badPin();
  if (outcome.kind === "locked") {
    throw new AppError("UNAUTHORIZED", "errors.station.pinLocked", undefined, {
      params: { until: outcome.until.toISOString() },
    });
  }
  return { userName: outcome.userName };
}

/** Scan your badge (SPEC-identity "Unlock with badge"): only its SHA-256 is stored. */
export async function unlockWithBadge(
  db: Db,
  station: Station,
  { code }: UnlockBadgeInput,
  now: Date = new Date(),
): Promise<StationUnlocked> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { badgeCode: hashBadgeCode(code) } });
    if (!user?.active) throw new AppError("UNAUTHORIZED", "errors.station.badBadge");
    await activate(tx, station, user, "BADGE", now);
    return { userName: user.name };
  });
}

/**
 * Makes `user` the one acting on the station: the previous user's turn ends (`SWITCHED_USER`, or
 * `IDLE` if it already timed out); the same user unlocking again within the limit keeps theirs. The station row lock serializes two people unlocking
 * the same tablet at once, and catches a revoke since the cookie was read.
 */
async function activate(
  tx: DbTx,
  station: Station,
  user: User,
  method: StationUnlockMethod,
  now: Date,
): Promise<void> {
  const [row] = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT active FROM stations WHERE id = ${station.id}::uuid FOR NO KEY UPDATE`;
  if (!row?.active) throw new AppError("UNAUTHORIZED", "errors.station.unknown");

  let open = await openActivation(tx, station.id);
  if (open) {
    const deadline = await idleDeadline(tx, open.lastActivityAt);
    if (deadline < now) {
      await endIdle(tx, open.id, deadline);
      open = null;
    }
  }
  if (open?.userId === user.id) {
    await tx.stationActivation.update({ where: { id: open.id }, data: { lastActivityAt: now } });
  } else {
    if (open) {
      await tx.stationActivation.update({
        where: { id: open.id },
        data: { endedAt: now, endReason: "SWITCHED_USER" },
      });
    }
    await tx.stationActivation.create({
      data: { stationId: station.id, userId: user.id, method, startedAt: now, lastActivityAt: now },
    });
  }
  const actor: UserActor = { userId: user.id, roles: user.roles, stationId: station.id };
  await recordAudit(tx, actor, {
    entityType: "Station",
    entityId: station.id,
    action: "station.unlock",
    after: { method },
    at: now,
  });
}

/** The Lock button: the station actor's turn ends (`MANUAL`) and the lock screen returns. */
export async function lockStation(db: Db, actor: Actor): Promise<void> {
  const { stationId } = actor;
  if (stationId === null) throw new AppError("FORBIDDEN", "errors.station.notStation");
  await db.$transaction(async (tx) => {
    const { count } = await tx.stationActivation.updateMany({
      where: { stationId, userId: actor.userId, endedAt: null },
      data: { endedAt: new Date(), endReason: "MANUAL" },
    });
    if (count === 0) return;
    await recordAudit(tx, actor, {
      entityType: "Station",
      entityId: stationId,
      action: "station.lock",
    });
  });
}
