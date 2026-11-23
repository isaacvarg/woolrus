import { createHash, randomBytes } from "node:crypto";
import {
  type RegisterStationInput,
  type RenameStationInput,
  StationName,
  type StationSummary,
} from "@woolrus/contracts";
import { type Db, type DbTx, Prisma, type Station } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";

// Shared floor tablets (SPEC-identity "Stations"): registering and administering them. A station
// holds a long-lived random token in an httpOnly cookie; only its SHA-256 is stored, so a database
// read can't impersonate a station. Who is working on one is in `station-session.ts`.

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
export function parseStationName(name: string): string {
  const parsed = StationName.safeParse(name);
  if (parsed.success) return parsed.data;
  const key = parsed.error.issues[0]?.message;
  throw new AppError("BAD_REQUEST", "errors.validation", {
    name: key === "errors.stations.nameTooLong" ? key : "errors.field.required",
  });
}

export const stationNameTaken = () =>
  new AppError("CONFLICT", "errors.stations.nameTaken", { name: "errors.stations.nameTaken" });

/** Rethrows a unique-name violation as `errors.stations.nameTaken`, anything else as is. */
export function rethrowNameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw stationNameTaken();
  }
  throw error;
}

/**
 * Creates the station with a new random 32-byte token (only its SHA-256 is stored) and audits
 * `station.register` as `registeredBy`. Shared by Register and setup codes, so both make the same
 * station. A taken name throws Prisma's P2002 (see `rethrowNameTaken`).
 */
export async function createStation(
  tx: DbTx,
  registeredBy: Actor,
  { name, audit }: { name: string; audit?: Record<string, string> },
): Promise<{ station: StationSummary; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const { id } = await tx.station.create({
    data: { name, tokenHash: hashStationToken(token), registeredById: registeredBy.userId },
  });
  await recordAudit(tx, registeredBy, {
    entityType: "Station",
    entityId: id,
    action: "station.register",
    after: { name, ...audit },
  });
  return { station: await summary(tx, id), token };
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
  const name = parseStationName(input.name);
  try {
    return await db.$transaction((tx) => createStation(tx, actor, { name }));
  } catch (error) {
    rethrowNameTaken(error);
  }
}

export async function renameStation(
  db: Db,
  actor: Actor,
  input: RenameStationInput,
): Promise<StationSummary> {
  assertCan(actor, "station.manage");
  const name = parseStationName(input.name);
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
    rethrowNameTaken(error);
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
