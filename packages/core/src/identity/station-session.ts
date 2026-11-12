import type {
  StationStatus,
  StationUnlocked,
  UnlockBadgeInput,
  UnlockPinInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Station, StationUnlockMethod, User } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import type { Actor, UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { hashBadgeCode, hashPin, verifyPin } from "./credentials";

// A worker's turn on a station (SPEC-identity "Stations", "Actor resolution"): the lock screen,
// unlocking by PIN or badge, switching users, idle lock and Lock. Each turn is a
// StationActivation; the station only says where an action happened, never what is allowed.

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

/** What one PIN attempt came to. `ok` carries the user, read under the row lock. */
export type PinCheck =
  | { kind: "ok"; user: User }
  | { kind: "bad" }
  | { kind: "locked"; until: Date };

/**
 * One PIN attempt for `userId`, inside the caller's transaction. The lock screen and approvals
 * share it, so they share one counter (SPEC-identity decision 18): 5 wrong PINs in a row lock that
 * user's PIN for 15 minutes on every station and in every approval; the right PIN resets the count.
 * An unknown, inactive or PIN-less user is checked against a decoy hash and comes back `bad`, the
 * same as a wrong PIN, so tiles can't be used to probe. The count must survive the refusal: return
 * the outcome from the transaction, then throw `pinCheckError` after it commits.
 */
export async function checkPin(
  tx: DbTx,
  userId: string,
  pin: string,
  now: Date,
): Promise<PinCheck> {
  // Serializes attempts for this user, so parallel guesses can't each see a count below 5.
  // NO KEY: a plain FOR UPDATE would also block inserts that reference the user (sessions).
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user?.active || !user.pinHash) {
    await verifyPin(pin, await decoyPinHash());
    return { kind: "bad" };
  }
  if (user.pinLockedUntil && user.pinLockedUntil > now) {
    return { kind: "locked", until: user.pinLockedUntil };
  }
  if (!(await verifyPin(pin, user.pinHash))) {
    const attempts = user.pinFailedAttempts + 1;
    if (attempts < PIN_MAX_ATTEMPTS) {
      await tx.user.update({ where: { id: userId }, data: { pinFailedAttempts: attempts } });
      return { kind: "bad" };
    }
    const until = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000);
    await tx.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: 0, pinLockedUntil: until },
    });
    return { kind: "locked", until };
  }
  if (user.pinFailedAttempts > 0 || user.pinLockedUntil) {
    await tx.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
  }
  return { kind: "ok", user };
}

/** The lock screen's error for a refused attempt: `badPin`, or `pinLocked` with the unlock time. */
export function pinCheckError(check: Exclude<PinCheck, { kind: "ok" }>): AppError {
  if (check.kind === "bad") return badPin();
  return new AppError("UNAUTHORIZED", "errors.station.pinLocked", undefined, {
    params: { until: check.until.toISOString() },
  });
}

/**
 * Tap your name, enter your PIN (SPEC-identity "Unlock with PIN"). The attempt is `checkPin`'s; the
 * transaction returns its outcome and the error is thrown after the commit, so the count sticks.
 */
export async function unlockWithPin(
  db: Db,
  station: Station,
  { userId, pin }: UnlockPinInput,
  now: Date = new Date(),
): Promise<StationUnlocked> {
  const outcome = await db.$transaction(async (tx) => {
    const check = await checkPin(tx, userId, pin, now);
    if (check.kind !== "ok") return check;
    await activate(tx, station, check.user, "PIN", now);
    return { kind: "ok", userName: check.user.name } as const;
  });
  if (outcome.kind !== "ok") throw pinCheckError(outcome);
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
    const match = await tx.user.findUnique({
      where: { badgeCode: hashBadgeCode(code) },
      select: { id: true },
    });
    // As in the PIN path: lock, then read, so a deactivation can't commit between the check and
    // the new activation (it waits, then ends that activation itself).
    if (match) {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${match.id}::uuid FOR NO KEY UPDATE`;
    }
    const user = match && (await tx.user.findUnique({ where: { id: match.id } }));
    if (!user?.active || user.badgeCode !== hashBadgeCode(code)) {
      throw new AppError("UNAUTHORIZED", "errors.station.badBadge");
    }
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
export async function lockStation(db: Db, actor: Actor, now: Date = new Date()): Promise<void> {
  const { stationId } = actor;
  if (stationId === null) throw new AppError("FORBIDDEN", "errors.station.notStation");
  await db.$transaction(async (tx) => {
    const { count } = await tx.stationActivation.updateMany({
      where: { stationId, userId: actor.userId, endedAt: null },
      data: { endedAt: now, endReason: "MANUAL" },
    });
    if (count === 0) return;
    await recordAudit(tx, actor, {
      entityType: "Station",
      entityId: stationId,
      action: "station.lock",
      at: now,
    });
  });
}
