import { createHash } from "node:crypto";
import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { assertCan, type UserActor } from "../permissions";
import { beginPicking } from "../workflow/service";
import { hashBadgeCode, hashPin } from "./credentials";
import {
  findStationByToken,
  listStations,
  lockStation,
  registerStation,
  renameStation,
  revokeStation,
  stationActor,
  stationStatus,
  unlockWithBadge,
  unlockWithPin,
} from "./stations";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const nonAdmins: Role[] = ["PICKER", "PACKER", "QA", "SHIPPER"];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("registerStation", () => {
  it("creates the station with a random token, storing only its SHA-256, and audits", async () => {
    const admin = await createActor(db, ["ADMIN"]);

    const { station, token } = await registerStation(db, admin, { name: "  Pack 2 " });

    expect(station).toMatchObject({ name: "Pack 2", active: true, currentUserName: null });
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = await db.station.findUniqueOrThrow({ where: { id: station.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.registeredById).toBe(admin.userId);
    expect(JSON.stringify(station)).not.toContain(token);
    expect(JSON.stringify(station)).not.toContain(row.tokenHash);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: station.id } });
    expect(audit).toMatchObject({ entityType: "Station", action: "station.register" });
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(row.tokenHash);
  });

  it("needs a unique name of 1–40 characters", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await registerStation(db, admin, { name: "Pack 2" });
    await expect(registerStation(db, admin, { name: "Pack 2" })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.stations.nameTaken",
    });
    for (const name of ["", "   ", "x".repeat(41)]) {
      await expect(registerStation(db, admin, { name })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
    }
  });

  it("needs a personal session: an admin unlocked on a station can't register another", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { station } = await registerStation(db, admin, { name: "Pick 1" });
    await expect(
      registerStation(db, { ...admin, stationId: station.id }, { name: "Pick 2" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN", messageKey: "errors.stations.personalOnly" });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(
      registerStation(db, await createActor(db, [role]), { name: "Nope" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("findStationByToken and stationStatus", () => {
  it("finds an active station by its token, and nothing for a revoked or unknown one", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { station, token } = await registerStation(db, admin, { name: "Pack 2" });

    const found = await findStationByToken(db, token);
    expect(found?.id).toBe(station.id);
    expect(await stationStatus(db, found ?? never())).toMatchObject({
      id: station.id,
      name: "Pack 2",
      activeUserName: null,
    });

    expect(await findStationByToken(db, "not-a-token")).toBeNull();
    await revokeStation(db, admin, { id: station.id });
    expect(await findStationByToken(db, token)).toBeNull();
  });
});

function never(): never {
  throw new Error("expected a station");
}

describe("listStations", () => {
  it("lists stations with the user unlocked on each", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    await db.user.update({ where: { id: packer.userId }, data: { name: "Ana" } });
    const { station: busy } = await registerStation(db, admin, { name: "Pack 1" });
    const { station: idle } = await registerStation(db, admin, { name: "Pack 2" });
    await db.stationActivation.create({
      data: { stationId: busy.id, userId: packer.userId, method: "PIN" },
    });
    await db.stationActivation.create({
      data: {
        stationId: idle.id,
        userId: packer.userId,
        method: "PIN",
        endedAt: new Date(),
        endReason: "MANUAL",
      },
    });

    const names = Object.fromEntries(
      (await listStations(db, admin)).map((s) => [s.name, s.currentUserName]),
    );
    expect(names).toEqual({ "Pack 1": "Ana", "Pack 2": null });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(listStations(db, await createActor(db, [role]))).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("renameStation", () => {
  it("renames and audits before and after; names stay unique", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { station } = await registerStation(db, admin, { name: "Pack 1" });
    await registerStation(db, admin, { name: "Pack 2" });

    expect((await renameStation(db, admin, { id: station.id, name: "Pick 1" })).name).toBe(
      "Pick 1",
    );
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityId: station.id, action: "station.rename" },
    });
    expect(audit).toMatchObject({ before: { name: "Pack 1" }, after: { name: "Pick 1" } });
    await expect(
      renameStation(db, admin, { id: station.id, name: "Pack 2" }),
    ).rejects.toMatchObject({ messageKey: "errors.stations.nameTaken" });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(
      renameStation(db, await createActor(db, [role]), { id: crypto.randomUUID(), name: "X" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("revokeStation", () => {
  it("deactivates it, ends its open activation as STATION_REVOKED, audits, and is idempotent", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    const { station } = await registerStation(db, admin, { name: "Pack 1" });
    const activation = await db.stationActivation.create({
      data: { stationId: station.id, userId: packer.userId, method: "BADGE" },
    });

    expect(await revokeStation(db, admin, { id: station.id })).toMatchObject({
      active: false,
      currentUserName: null,
    });
    expect(await revokeStation(db, admin, { id: station.id })).toMatchObject({ active: false });

    expect(
      await db.stationActivation.findUniqueOrThrow({ where: { id: activation.id } }),
    ).toMatchObject({ endReason: "STATION_REVOKED" });
    expect(
      await db.auditEvent.count({ where: { entityId: station.id, action: "station.revoke" } }),
    ).toBe(1);
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(
      revokeStation(db, await createActor(db, [role]), { id: crypto.randomUUID() }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

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
