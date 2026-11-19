import { createHash, randomBytes } from "node:crypto";
import type { IssueStationSetupCodeInput, StationSummary } from "@woolrus/contracts";
import type { Db, DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, forbidden } from "../errors";
import { type Actor, assertCan, can, type UserActor } from "../permissions";
import { CROCKFORD } from "./credentials";
import { createStation, parseStationName, rethrowNameTaken, stationNameTaken } from "./stations";

// Station setup codes (SPEC-identity A3): an admin's one-time approval for one future station,
// redeemed by whichever device presents it first. 10 Crockford base32 characters (50 bits), shown
// as `XXXXX-XXXXX`; only the SHA-256 of the 10 characters is stored, like badges and station tokens.

export const SETUP_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_OPEN_SETUP_CODES = 5;
const CODE_LENGTH = 10;

/** One lock for every issue, so the open-code count and the name check can't race. */
const ISSUE_LOCK = "station-setup-codes:issue";

function newSetupCode(): string {
  const chars = [...randomBytes(CODE_LENGTH)].map((byte) => CROCKFORD[byte & 31]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/**
 * The 10 canonical characters of what someone typed, or null if it can't be a code: uppercase,
 * spaces and dashes dropped, `I`/`L` read as `1` and `O` as `0` (Crockford's look-alikes).
 */
export function normalizeSetupCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((char) => CROCKFORD.includes(char)) ? code : null;
}

const hashSetupCode = (canonical: string) => createHash("sha256").update(canonical).digest("hex");

/** Not used, not cancelled, not expired at `now`. */
const openAt = (now: Date) =>
  ({
    usedAt: null,
    cancelledAt: null,
    expiresAt: { gt: now },
  }) satisfies Prisma.StationSetupCodeWhereInput;

export type IssuedSetupCode = { id: string; name: string; code: string; expiresAt: Date };

/**
 * Issues a code for a station called `name`. Returns the code once; it's never stored, logged or
 * audited. Only from a personal session (decision 26): a station actor, even an unlocked Admin, is
 * refused. The caller adds the QR of the setup link.
 */
export async function issueStationSetupCode(
  db: Db,
  actor: Actor,
  input: IssueStationSetupCodeInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<IssuedSetupCode> {
  assertCan(actor, "station.manage");
  if (actor.stationId !== null) throw new AppError("FORBIDDEN", "errors.stations.personalOnly");
  if (actor.userId === null) throw forbidden(); // A system actor approves nothing.
  const { userId } = actor;
  const name = parseStationName(input.name);
  const code = newSetupCode();
  const expiresAt = new Date(now.getTime() + SETUP_CODE_TTL_MS);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ISSUE_LOCK}))`;
    const [station, sameName, open] = await Promise.all([
      tx.station.findUnique({ where: { name }, select: { id: true } }),
      tx.stationSetupCode.findFirst({ where: { name, ...openAt(now) }, select: { id: true } }),
      tx.stationSetupCode.count({ where: openAt(now) }),
    ]);
    if (station || sameName) throw stationNameTaken();
    if (open >= MAX_OPEN_SETUP_CODES) {
      throw new AppError("CONFLICT", "errors.stations.tooManySetupCodes", undefined, {
        params: { max: MAX_OPEN_SETUP_CODES },
      });
    }
    const { id } = await tx.stationSetupCode.create({
      data: {
        codeHash: hashSetupCode(code.replace("-", "")),
        name,
        createdById: userId,
        expiresAt,
      },
    });
    await recordAudit(tx, actor, {
      entityType: "StationSetupCode",
      entityId: id,
      action: "station.setupCode.issue",
      after: { name, expiresAt: expiresAt.toISOString() },
    });
    return { id, name, code, expiresAt };
  });
}

const badSetupCode = () => new AppError("UNAUTHORIZED", "errors.stations.badSetupCode");

/**
 * Claims the code's row: the conditional update lets exactly one of several racing devices win
 * (the losers re-read the row after the winner commits and match nothing). Null if the code isn't
 * open, or its issuer no longer stands behind it.
 */
async function claim(tx: DbTx, codeHash: string, now: Date) {
  const claimed = await tx.stationSetupCode.updateMany({
    where: { codeHash, ...openAt(now) },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return null;
  const row = await tx.stationSetupCode.findUniqueOrThrow({
    where: { codeHash },
    select: {
      id: true,
      name: true,
      createdBy: { select: { id: true, active: true, roles: true } },
    },
  });
  // The admin's approval no longer stands once they're deactivated or no longer manage stations.
  const issuer: UserActor = {
    userId: row.createdBy.id,
    roles: row.createdBy.roles,
    stationId: null,
  };
  if (!row.createdBy.active || !can(issuer, "station.manage")) return null;
  return { ...row, issuer };
}

/**
 * Redeems a setup code from the device itself (no actor: it has no session). Creates the station
 * exactly as Register does, registered by the issuing admin, and returns its token for the cookie.
 * Wrong, used, cancelled and expired codes, and a code whose issuer no longer stands behind it, all
 * throw the same `errors.stations.badSetupCode`. A name taken since fails with `nameTaken` and the
 * code stays unused (the whole transaction rolls back).
 */
export async function redeemStationSetupCode(
  db: Db,
  { code, now }: { code: string; now: Date },
): Promise<{ station: StationSummary; token: string }> {
  const canonical = normalizeSetupCode(code);
  if (!canonical) throw badSetupCode();
  const codeHash = hashSetupCode(canonical);
  try {
    return await db.$transaction(async (tx) => {
      const claimed = await claim(tx, codeHash, now);
      if (!claimed) throw badSetupCode();
      const made = await createStation(tx, claimed.issuer, {
        name: claimed.name,
        audit: { via: "setupCode", setupCodeId: claimed.id },
      });
      await tx.stationSetupCode.update({
        where: { id: claimed.id },
        data: { stationId: made.station.id },
      });
      return made;
    });
  } catch (error) {
    rethrowNameTaken(error);
  }
}
