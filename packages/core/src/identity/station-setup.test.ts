import { createHash } from "node:crypto";
import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import {
  issueStationSetupCode,
  MAX_OPEN_SETUP_CODES,
  normalizeSetupCode,
  redeemStationSetupCode,
  SETUP_CODE_TTL_MS,
} from "./station-setup";
import { findStationByToken, registerStation } from "./stations";

// SPEC-identity A3, "Station setup codes": success criteria 29–31.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const nonAdmins: Role[] = ["PICKER", "PACKER", "QA", "SHIPPER"];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const badSetupCode = { kind: "UNAUTHORIZED", messageKey: "errors.stations.badSetupCode" };

/** How a person might type `code` off the screen: lowercase, spaced, `O` for `0`, `l` for `1`. */
function sloppy(code: string): string {
  const typed = code.toLowerCase().replace("-", " - ").replaceAll("0", "O").replaceAll("1", "l");
  return ` ${typed} `;
}

describe("normalizeSetupCode", () => {
  it("reads case, spaces, dashes and Crockford look-alikes the forgiving way", () => {
    expect(normalizeSetupCode(" 7kq4m - xd2ra ")).toBe("7KQ4MXD2RA");
    expect(normalizeSetupCode("OIL00-iloo1")).toBe("0110011001");
  });

  it("rejects anything that isn't 10 Crockford characters", () => {
    for (const code of ["", "7KQ4M", "7KQ4M-XD2RAX", "7KQ4M-XD2R!", "7KQ4U-XD2RA"]) {
      expect(normalizeSetupCode(code)).toBeNull();
    }
  });
});

describe("issueStationSetupCode", () => {
  it("returns a 10-character code once, stores only its SHA-256, and audits without it", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const before = Date.now();

    const issued = await issueStationSetupCode(db, admin, { name: "  Pack 3 " });

    expect(issued.name).toBe("Pack 3");
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SETUP_CODE_TTL_MS);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SETUP_CODE_TTL_MS);
    const row = await db.stationSetupCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row).toMatchObject({ name: "Pack 3", createdById: admin.userId, usedAt: null });
    expect(row.codeHash).toBe(sha256(issued.code.replace("-", "")));

    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: issued.id } });
    expect(audit).toMatchObject({
      entityType: "StationSetupCode",
      action: "station.setupCode.issue",
      actorId: admin.userId,
      after: { name: "Pack 3", expiresAt: issued.expiresAt.toISOString() },
    });
    const json = JSON.stringify(audit);
    expect(json).not.toContain(issued.code.replace("-", ""));
    expect(json).not.toContain(issued.code);
    expect(json).not.toContain(row.codeHash);
  });

  it("needs a personal session: an admin unlocked on a station can't issue", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { station } = await registerStation(db, admin, { name: "Pick 1" });
    await expect(
      issueStationSetupCode(db, { ...admin, stationId: station.id }, { name: "Pack 3" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN", messageKey: "errors.stations.personalOnly" });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(
      issueStationSetupCode(db, await createActor(db, [role]), { name: "Nope" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("follows the station name rules", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    for (const name of ["", "   ", "x".repeat(41)]) {
      await expect(issueStationSetupCode(db, admin, { name })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
    }
  });

  it("refuses a name taken by a station or by another open code, not by a closed one", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await registerStation(db, admin, { name: "Pack 2" });
    const nameTaken = { kind: "CONFLICT", messageKey: "errors.stations.nameTaken" };
    await expect(issueStationSetupCode(db, admin, { name: "Pack 2" })).rejects.toMatchObject(
      nameTaken,
    );

    const open = await issueStationSetupCode(db, admin, { name: "Pack 3" });
    await expect(issueStationSetupCode(db, admin, { name: "Pack 3" })).rejects.toMatchObject(
      nameTaken,
    );

    // Once that code has expired, the name is free again.
    await db.stationSetupCode.update({
      where: { id: open.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(issueStationSetupCode(db, admin, { name: "Pack 3" })).resolves.toMatchObject({
      name: "Pack 3",
    });
  });

  it(`allows at most ${MAX_OPEN_SETUP_CODES} open codes at once`, async () => {
    const admin = await createActor(db, ["ADMIN"]);
    for (let i = 1; i <= MAX_OPEN_SETUP_CODES; i++) {
      await issueStationSetupCode(db, admin, { name: `Pack ${i}` });
    }
    await expect(issueStationSetupCode(db, admin, { name: "Pack 6" })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.stations.tooManySetupCodes",
    });
    expect(await db.stationSetupCode.count()).toBe(MAX_OPEN_SETUP_CODES);
  });
});

describe("redeemStationSetupCode", () => {
  it("creates the station as the admin registered it, typed sloppily", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const issued = await issueStationSetupCode(db, admin, { name: "Pack 3" });

    const { station, token } = await redeemStationSetupCode(db, {
      code: sloppy(issued.code),
      now: new Date(),
    });

    expect(station).toMatchObject({ name: "Pack 3", active: true, currentUserName: null });
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = await db.station.findUniqueOrThrow({ where: { id: station.id } });
    expect(row).toMatchObject({ registeredById: admin.userId, tokenHash: sha256(token) });
    expect((await findStationByToken(db, token))?.id).toBe(station.id);

    const code = await db.stationSetupCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(code.usedAt).not.toBeNull();
    expect(code.stationId).toBe(station.id);

    const audits = await db.auditEvent.findMany({ where: { action: "station.register" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "Station",
      entityId: station.id,
      actorId: admin.userId,
      stationId: null,
      after: { name: "Pack 3", via: "setupCode", setupCodeId: issued.id },
    });
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify({ station })).not.toContain(issued.code);
  });

  it("works once: a second redeem fails like a random code and creates nothing", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const issued = await issueStationSetupCode(db, admin, { name: "Pack 3" });
    await redeemStationSetupCode(db, { code: issued.code, now: new Date() });

    await expect(
      redeemStationSetupCode(db, { code: issued.code, now: new Date() }),
    ).rejects.toMatchObject(badSetupCode);
    await expect(
      redeemStationSetupCode(db, { code: "7KQ4M-XD2RA", now: new Date() }),
    ).rejects.toMatchObject(badSetupCode);
    await expect(
      redeemStationSetupCode(db, { code: "not a code at all", now: new Date() }),
    ).rejects.toMatchObject(badSetupCode);
    expect(await db.station.count()).toBe(1);
  });

  it("expires after 10 minutes", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const issued = await issueStationSetupCode(db, admin, { name: "Pack 3" });
    const later = new Date(issued.expiresAt.getTime() + 1);

    await expect(
      redeemStationSetupCode(db, { code: issued.code, now: later }),
    ).rejects.toMatchObject(badSetupCode);
    await expect(
      redeemStationSetupCode(db, { code: issued.code, now: issued.expiresAt }),
    ).rejects.toMatchObject(badSetupCode);
    expect(await db.station.count()).toBe(0);
    const row = await db.stationSetupCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.usedAt).toBeNull();
  });

  it("fails when cancelled", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const issued = await issueStationSetupCode(db, admin, { name: "Pack 3" });
    await db.stationSetupCode.update({
      where: { id: issued.id },
      data: { cancelledAt: new Date() },
    });

    await expect(
      redeemStationSetupCode(db, { code: issued.code, now: new Date() }),
    ).rejects.toMatchObject(badSetupCode);
    expect(await db.station.count()).toBe(0);
  });

  it("fails like a wrong code once the issuing admin is deactivated or no longer an admin", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const deactivated = await issueStationSetupCode(db, admin, { name: "Pack 3" });
    const demoted = await issueStationSetupCode(db, admin, { name: "Pack 4" });

    await db.user.update({ where: { id: admin.userId }, data: { active: false } });
    await expect(
      redeemStationSetupCode(db, { code: deactivated.code, now: new Date() }),
    ).rejects.toMatchObject(badSetupCode);

    await db.user.update({
      where: { id: admin.userId },
      data: { active: true, roles: ["PACKER"] },
    });
    await expect(
      redeemStationSetupCode(db, { code: demoted.code, now: new Date() }),
    ).rejects.toMatchObject(badSetupCode);
    expect(await db.station.count()).toBe(0);
  });

  it("leaves the code unused when the name was taken since", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const issued = await issueStationSetupCode(db, admin, { name: "Pack 3" });
    await registerStation(db, admin, { name: "Pack 3" });

    await expect(
      redeemStationSetupCode(db, { code: issued.code, now: new Date() }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.stations.nameTaken" });
    const row = await db.stationSetupCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row).toMatchObject({ usedAt: null, stationId: null });
  });

  it("gives one winner when two devices redeem the same code at once", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const issued = await issueStationSetupCode(db, admin, { name: "Pack 3" });

    const results = await Promise.allSettled(
      [0, 1, 2].map(() => redeemStationSetupCode(db, { code: issued.code, now: new Date() })),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((r) => r.status === "rejected")) {
      expect(result.reason).toMatchObject(badSetupCode);
    }
    expect(await db.station.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "station.register" } })).toBe(1);
  });
});
