import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { assertCan, type UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { beginPicking } from "../workflow/service";
import { hashBadgeCode, hashPin } from "./credentials";
import {
  lockStation,
  stationActor,
  stationStatus,
  touchStation,
  unlockWithBadge,
  unlockWithPin,
} from "./station-session";
import { findStationByToken, registerStation } from "./stations";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

function never(): never {
  throw new Error("expected a value");
}

// --- Unlocking (SPEC-identity "Stations", success criteria 5, 6, 8) ---

const PIN = "482916";

/** A floor worker with a PIN and a badge. */
async function worker(name: string, roles: Role[], badge = `WRB-${name.toUpperCase()}`) {
  const actor = await createActor(db, roles);
  await db.user.update({
    where: { id: actor.userId },
    data: { name, pinHash: await hashPin(PIN), badgeCode: hashBadgeCode(badge) },
  });
  return { ...actor, badge };
}

async function newStation(name = "Pack 2") {
  const admin = await createActor(db, ["ADMIN"]);
  const { token } = await registerStation(db, admin, { name });
  return (await findStationByToken(db, token)) ?? never();
}

const openActivations = (stationId: string) =>
  db.stationActivation.findMany({ where: { stationId, endedAt: null } });

describe("stationStatus tiles", () => {
  it("lists active users with a PIN, name and initials only, most recent on this station first", async () => {
    const station = await newStation();
    const other = await newStation("Pick 1");
    const ana = await worker("Ana Lopez", ["PACKER"]);
    const bo = await worker("Bo", ["PICKER"]);
    const cy = await worker("Cy Young", ["QA"]);
    const gone = await worker("Gone", ["QA"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });
    await createActor(db, ["PACKER"]); // no PIN: no tile
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db.stationActivation.createMany({
      data: [
        { stationId: station.id, userId: cy.userId, method: "PIN", startedAt: at(5) },
        { stationId: station.id, userId: ana.userId, method: "PIN", startedAt: at(60) },
        // Elsewhere doesn't count.
        { stationId: other.id, userId: bo.userId, method: "PIN", startedAt: at(1) },
      ],
    });

    const status = await stationStatus(db, station);

    expect(status.tiles).toEqual([
      { id: cy.userId, name: "Cy Young", initials: "CY" },
      { id: ana.userId, name: "Ana Lopez", initials: "AL" },
      { id: bo.userId, name: "Bo", initials: "B" },
    ]);
    expect(status.activeUserName).toBe("Cy Young");
    const body = JSON.stringify(status);
    expect(body).not.toContain("scrypt");
    expect(body).not.toContain(hashBadgeCode(ana.badge));
  });
});

describe("unlockWithPin", () => {
  it("opens an activation for the user and audits station.unlock as them, from the station", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);

    expect(await unlockWithPin(db, station, { userId: ana.userId, pin: PIN })).toEqual({
      userName: "Ana",
    });

    const [activation] = await openActivations(station.id);
    expect(activation).toMatchObject({ userId: ana.userId, method: "PIN" });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "station.unlock" } });
    expect(audit).toMatchObject({
      entityType: "Station",
      entityId: station.id,
      actorId: ana.userId,
      stationId: station.id,
      after: { method: "PIN" },
    });
    expect(JSON.stringify(audit)).not.toContain(PIN);
  });

  it("gives the same badPin for a wrong PIN, an unknown user, a user without a PIN and an inactive one", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    const noPin = await createActor(db, ["PACKER"]);
    const gone = await worker("Gone", ["PACKER"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });

    for (const input of [
      { userId: ana.userId, pin: "000001" },
      { userId: ana.userId, pin: "not a pin" },
      { userId: crypto.randomUUID(), pin: PIN },
      { userId: noPin.userId, pin: PIN },
      { userId: gone.userId, pin: PIN },
    ]) {
      await expect(unlockWithPin(db, station, input)).rejects.toMatchObject({
        kind: "UNAUTHORIZED",
        messageKey: "errors.station.badPin",
      });
    }
    expect(await openActivations(station.id)).toHaveLength(0);
  });

  it("locks the PIN for 15 minutes after 5 wrong tries, on every station, and a right PIN resets the count", async () => {
    const station = await newStation();
    const elsewhere = await newStation("Pick 1");
    const ana = await worker("Ana", ["PACKER"]);
    const now = new Date("2026-10-20T10:00:00Z");
    const wrong = (at = now, on = station) =>
      unlockWithPin(db, on, { userId: ana.userId, pin: "111112" }, at);

    // Four misses, then the right PIN: the count starts over.
    for (let i = 0; i < 4; i++)
      await expect(wrong()).rejects.toMatchObject({ messageKey: "errors.station.badPin" });
    await unlockWithPin(db, station, { userId: ana.userId, pin: PIN }, now);
    expect((await db.user.findUniqueOrThrow({ where: { id: ana.userId } })).pinFailedAttempts).toBe(
      0,
    );

    for (let i = 0; i < 4; i++)
      await expect(wrong()).rejects.toMatchObject({ messageKey: "errors.station.badPin" });
    const until = new Date("2026-10-20T10:15:00Z");
    await expect(wrong()).rejects.toMatchObject({
      kind: "UNAUTHORIZED",
      messageKey: "errors.station.pinLocked",
      params: { until: until.toISOString() },
    });

    // Locked everywhere, even with the right PIN, until it expires.
    const later = new Date("2026-10-20T10:14:59Z");
    await expect(
      unlockWithPin(db, elsewhere, { userId: ana.userId, pin: PIN }, later),
    ).rejects.toMatchObject({ messageKey: "errors.station.pinLocked" });
    expect(await unlockWithPin(db, elsewhere, { userId: ana.userId, pin: PIN }, until)).toEqual({
      userName: "Ana",
    });
  });
});

describe("unlockWithBadge", () => {
  it("matches the scanned code's hash to an active user, in any case", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);

    expect(await unlockWithBadge(db, station, { code: ` ${ana.badge.toLowerCase()} ` })).toEqual({
      userName: "Ana",
    });
    expect(await openActivations(station.id)).toMatchObject([
      { userId: ana.userId, method: "BADGE" },
    ]);
  });

  it("refuses an unknown badge, or one of an inactive user, with badBadge", async () => {
    const station = await newStation();
    const gone = await worker("Gone", ["PACKER"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });

    for (const code of ["WRB-NOPE", gone.badge]) {
      await expect(unlockWithBadge(db, station, { code })).rejects.toMatchObject({
        kind: "UNAUTHORIZED",
        messageKey: "errors.station.badBadge",
      });
    }
  });
});

describe("switching users", () => {
  it("ends A's activation as SWITCHED_USER when B unlocks, so the station acts as B", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    const bo = await worker("Bo", ["PICKER"]);

    await unlockWithPin(db, station, { userId: ana.userId, pin: PIN });
    expect((await stationActor(db, station))?.actor.userId).toBe(ana.userId);
    await unlockWithBadge(db, station, { code: bo.badge });

    const all = await db.stationActivation.findMany({ where: { stationId: station.id } });
    expect(all.find((a) => a.userId === ana.userId)).toMatchObject({ endReason: "SWITCHED_USER" });
    expect(await openActivations(station.id)).toMatchObject([{ userId: bo.userId }]);
    expect((await stationActor(db, station))?.actor).toEqual({
      userId: bo.userId,
      roles: ["PICKER"],
      stationId: station.id,
    });
  });

  it("keeps the activation when the same user unlocks again", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    await unlockWithPin(db, station, { userId: ana.userId, pin: PIN });
    await unlockWithBadge(db, station, { code: ana.badge });
    expect(await db.stationActivation.count({ where: { stationId: station.id } })).toBe(1);
  });

  it("refuses to unlock a station revoked since its cookie was read", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    await db.station.update({ where: { id: station.id }, data: { active: false } });
    await expect(unlockWithBadge(db, station, { code: ana.badge })).rejects.toMatchObject({
      kind: "UNAUTHORIZED",
      messageKey: "errors.station.unknown",
    });
  });
});

describe("stationActor", () => {
  it("is nobody when the station is locked or its user was deactivated", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    expect(await stationActor(db, station)).toBeNull();
    await unlockWithPin(db, station, { userId: ana.userId, pin: PIN });
    await db.user.update({ where: { id: ana.userId }, data: { active: false } });
    expect(await stationActor(db, station)).toBeNull();
  });

  it("acts with exactly the user's roles and records the station on audit and stage events", async () => {
    const station = await newStation();
    const picker = await worker("Pia", ["PICKER"]);
    const admin = await worker("Al", ["ADMIN"]);
    const actorOf = async (): Promise<UserActor> =>
      (await stationActor(db, station))?.actor ?? never();

    await unlockWithPin(db, station, { userId: picker.userId, pin: PIN });
    const asPicker = await actorOf();
    expect(() => assertCan(asPicker, "order.pack")).toThrow();
    expect(() => assertCan(asPicker, "settings.manage")).toThrow();
    const { order } = await createOrder(db);
    await beginPicking(db, asPicker, { orderId: order.id, expectedVersion: 1 });
    expect(
      await db.orderStageEvent.findFirstOrThrow({ where: { orderId: order.id } }),
    ).toMatchObject({
      actorId: picker.userId,
      stationId: station.id,
    });
    expect(await db.auditEvent.findFirstOrThrow({ where: { entityId: order.id } })).toMatchObject({
      actorId: picker.userId,
      stationId: station.id,
    });

    await unlockWithBadge(db, station, { code: admin.badge });
    expect(() => assertCan(asPicker, "order.pick")).not.toThrow(); // the old object is just data
    const asAdmin = await actorOf();
    expect(() => assertCan(asAdmin, "settings.manage")).not.toThrow();
  });
});

describe("lockStation", () => {
  it("ends the station actor's activation as MANUAL and audits station.lock", async () => {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    await unlockWithPin(db, station, { userId: ana.userId, pin: PIN });
    const actor = (await stationActor(db, station))?.actor ?? never();

    await lockStation(db, actor);

    expect(await openActivations(station.id)).toHaveLength(0);
    expect(
      await db.stationActivation.findFirstOrThrow({ where: { stationId: station.id } }),
    ).toMatchObject({ endReason: "MANUAL" });
    expect(
      await db.auditEvent.findFirstOrThrow({ where: { action: "station.lock" } }),
    ).toMatchObject({ actorId: ana.userId, stationId: station.id, entityId: station.id });
    expect(await stationActor(db, station)).toBeNull();
  });

  it("is only for a station actor", async () => {
    const ana = await createActor(db, ["PACKER"]);
    await expect(lockStation(db, ana)).rejects.toMatchObject({
      kind: "FORBIDDEN",
      messageKey: "errors.station.notStation",
    });
  });
});

// --- Idle lock (SPEC-identity "Idle lock", success criterion 7). A fake clock, no sleeps. ---

describe("idle lock", () => {
  const t0 = new Date("2026-10-20T10:00:00Z");
  const minutesIn = (minutes: number, seconds = 0) =>
    new Date(t0.getTime() + minutes * 60_000 + seconds * 1000);

  /** Ana unlocked at t0 on a station with a 10-minute idle limit (the default). */
  async function unlocked() {
    const station = await newStation();
    const ana = await worker("Ana", ["PACKER"]);
    await unlockWithPin(db, station, { userId: ana.userId, pin: PIN }, t0);
    return { station, ana };
  }

  it("acts as the user until the deadline, which stationActor reports", async () => {
    const { station, ana } = await unlocked();
    const resolved = await stationActor(db, station, minutesIn(9, 59));
    expect(resolved?.actor.userId).toBe(ana.userId);
    expect(resolved?.idleLockAt).toEqual(minutesIn(10));
  });

  it("ends the activation as IDLE on the first request past the limit, and stays locked", async () => {
    const { station } = await unlocked();

    expect(await stationActor(db, station, minutesIn(10, 1))).toBeNull();

    expect(
      await db.stationActivation.findFirstOrThrow({ where: { stationId: station.id } }),
    ).toMatchObject({ endReason: "IDLE", endedAt: minutesIn(10) });
    expect(await stationActor(db, station, minutesIn(10, 2))).toBeNull();
  });

  it("follows Settings.stationIdleLockMinutes", async () => {
    const { station } = await unlocked();
    const { id } = await loadSettings(db);
    await db.settings.update({ where: { id }, data: { stationIdleLockMinutes: 2 } });
    expect(await stationActor(db, station, minutesIn(2, 1))).toBeNull();
  });

  it("is extended by station.touch, and not by reads", async () => {
    const { station } = await unlocked();

    // Reads (any authed request resolves the actor) don't count as activity.
    await stationActor(db, station, minutesIn(5));
    expect((await stationActor(db, station, minutesIn(9)))?.idleLockAt).toEqual(minutesIn(10));

    const actor = (await stationActor(db, station, minutesIn(9)))?.actor ?? never();
    expect(await touchStation(db, actor, minutesIn(9))).toEqual({ idleLockAt: minutesIn(19) });
    expect((await stationActor(db, station, minutesIn(18)))?.idleLockAt).toEqual(minutesIn(19));
    expect(await stationActor(db, station, minutesIn(19, 1))).toBeNull();
  });

  it("touch refuses once the limit has passed, and is only for a station actor", async () => {
    const { station } = await unlocked();
    const actor = (await stationActor(db, station, minutesIn(1)))?.actor ?? never();

    await expect(touchStation(db, actor, minutesIn(10, 1))).rejects.toMatchObject({
      kind: "UNAUTHORIZED",
      messageKey: "errors.station.locked",
    });
    expect(
      await db.stationActivation.findFirstOrThrow({ where: { stationId: station.id } }),
    ).toMatchObject({ endReason: "IDLE" });
    await expect(
      touchStation(db, await createActor(db, ["PACKER"]), minutesIn(1)),
    ).rejects.toMatchObject({ kind: "FORBIDDEN", messageKey: "errors.station.notStation" });
  });

  it("names nobody on the lock screen once the turn went idle", async () => {
    const { station } = await unlocked();
    expect((await stationStatus(db, station, minutesIn(9))).activeUserName).toBe("Ana");
    expect((await stationStatus(db, station, minutesIn(10, 1))).activeUserName).toBeNull();
  });

  it("starts a new activation when the same user unlocks after going idle", async () => {
    const { station, ana } = await unlocked();
    await unlockWithBadge(db, station, { code: ana.badge }, minutesIn(11));
    const all = await db.stationActivation.findMany({
      where: { stationId: station.id },
      orderBy: { startedAt: "asc" },
    });
    expect(all).toMatchObject([{ endReason: "IDLE" }, { endedAt: null, startedAt: minutesIn(11) }]);
  });

  it("updates Station.lastSeenAt at most once a minute", async () => {
    const { station } = await unlocked();
    const lastSeen = async () =>
      (await db.station.findUniqueOrThrow({ where: { id: station.id } })).lastSeenAt;

    await stationActor(db, station, minutesIn(1));
    expect(await lastSeen()).toEqual(minutesIn(1));
    await stationActor(db, station, minutesIn(1, 59));
    expect(await lastSeen()).toEqual(minutesIn(1));
    await stationActor(db, station, minutesIn(2));
    expect(await lastSeen()).toEqual(minutesIn(2));
  });
});
