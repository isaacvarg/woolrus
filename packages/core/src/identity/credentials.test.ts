import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { hashBadgeCode, verifyPin } from "./credentials";
import { clearPin, issueBadge, revokeBadge, setPin } from "./users";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const nonAdmins: Role[] = ["PICKER", "PACKER", "QA", "SHIPPER"];

async function setup() {
  return { admin: await createActor(db, ["ADMIN"]), target: await createActor(db, ["PACKER"]) };
}

const row = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

describe("setPin", () => {
  it("stores a salted scrypt hash, resets the lockout, and audits without the PIN", async () => {
    const { admin, target } = await setup();
    await db.user.update({
      where: { id: target.userId },
      data: { pinFailedAttempts: 4, pinLockedUntil: new Date(Date.now() + 60_000) },
    });

    const summary = await setPin(db, admin, { id: target.userId, pin: "482915" });

    expect(summary).toMatchObject({ hasPin: true, pinLockedUntil: null });
    const user = await row(target.userId);
    expect(user.pinHash).toMatch(/^scrypt\$/);
    expect(user.pinHash).not.toContain("482915");
    expect(user).toMatchObject({ pinFailedAttempts: 0, pinLockedUntil: null });
    expect(await verifyPin("482915", user.pinHash ?? "")).toBe(true);
    expect(await verifyPin("482916", user.pinHash ?? "")).toBe(false);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: target.userId } });
    expect(audit.action).toBe("user.pin.set");
    expect(JSON.stringify(audit)).not.toContain("482915");
    expect(JSON.stringify(audit)).not.toContain(user.pinHash);
  });

  it("salts per user: the same PIN hashes differently", async () => {
    const { admin, target } = await setup();
    const other = await createActor(db, ["PICKER"]);
    await setPin(db, admin, { id: target.userId, pin: "482915" });
    await setPin(db, admin, { id: other.userId, pin: "482915" });
    expect((await row(target.userId)).pinHash).not.toBe((await row(other.userId)).pinHash);
  });

  it("refuses a weak or malformed PIN", async () => {
    const { admin, target } = await setup();
    for (const pin of ["123456", "000000", "12345", "abcdef"]) {
      await expect(setPin(db, admin, { id: target.userId, pin })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
    }
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const { target } = await setup();
    await expect(
      setPin(db, await createActor(db, [role]), { id: target.userId, pin: "482915" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("clearPin", () => {
  it("removes the PIN and its lockout, and audits", async () => {
    const { admin, target } = await setup();
    await setPin(db, admin, { id: target.userId, pin: "482915" });
    await db.user.update({ where: { id: target.userId }, data: { pinFailedAttempts: 2 } });

    expect(await clearPin(db, admin, { id: target.userId })).toMatchObject({ hasPin: false });
    expect(await row(target.userId)).toMatchObject({ pinHash: null, pinFailedAttempts: 0 });
    expect(
      await db.auditEvent.count({ where: { entityId: target.userId, action: "user.pin.clear" } }),
    ).toBe(1);
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const { target } = await setup();
    await expect(
      clearPin(db, await createActor(db, [role]), { id: target.userId }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("issueBadge", () => {
  it("returns a WRB- code once and stores only its SHA-256", async () => {
    const { admin, target } = await setup();

    const { code, user } = await issueBadge(db, admin, { id: target.userId });

    expect(code).toMatch(/^WRB-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(user.hasBadge).toBe(true);
    const stored = await row(target.userId);
    expect(stored.badgeCode).toBe(hashBadgeCode(code));
    expect(stored.badgeCode).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.badgeIssuedAt).toBeInstanceOf(Date);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: target.userId } });
    expect(audit.action).toBe("user.badge.issue");
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(JSON.stringify(audit)).not.toContain(stored.badgeCode);
  });

  it("replaces any old badge", async () => {
    const { admin, target } = await setup();
    const first = await issueBadge(db, admin, { id: target.userId });
    const second = await issueBadge(db, admin, { id: target.userId });
    expect(second.code).not.toBe(first.code);
    expect((await row(target.userId)).badgeCode).toBe(hashBadgeCode(second.code));
  });

  it("matches a scanned code regardless of case", () => {
    expect(hashBadgeCode("wrb-abc")).toBe(hashBadgeCode("WRB-ABC"));
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const { target } = await setup();
    await expect(
      issueBadge(db, await createActor(db, [role]), { id: target.userId }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("revokeBadge", () => {
  it("removes the badge and audits", async () => {
    const { admin, target } = await setup();
    await issueBadge(db, admin, { id: target.userId });
    expect(await revokeBadge(db, admin, { id: target.userId })).toMatchObject({ hasBadge: false });
    expect(await row(target.userId)).toMatchObject({ badgeCode: null, badgeIssuedAt: null });
    expect(
      await db.auditEvent.count({
        where: { entityId: target.userId, action: "user.badge.revoke" },
      }),
    ).toBe(1);
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const { target } = await setup();
    await expect(
      revokeBadge(db, await createActor(db, [role]), { id: target.userId }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});
