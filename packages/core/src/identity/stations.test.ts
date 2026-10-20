import { createHash } from "node:crypto";
import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import {
  findStationByToken,
  listStations,
  registerStation,
  renameStation,
  revokeStation,
  stationStatus,
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
    expect(await stationStatus(db, found ?? never())).toEqual({ id: station.id, name: "Pack 2" });

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
