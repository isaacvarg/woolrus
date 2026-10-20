import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { UserActor } from "../permissions";
import { deactivateUser, listUsers, reactivateUser, updateUserRoles } from "./users";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

async function createSession(userId: string) {
  return db.session.create({
    data: { userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) },
  });
}

async function createStation(name: string) {
  return db.station.create({ data: { name, tokenHash: crypto.randomUUID() } });
}

const nonAdmins: Role[] = ["PICKER", "PACKER", "QA", "SHIPPER"];

describe("listUsers", () => {
  it("lists users with flags for PIN and badge, never their hashes", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const picker = await createActor(db, ["PICKER"]);
    await db.user.update({
      where: { id: picker.userId },
      data: { name: "Ana", pinHash: "scrypt$salt$hash", badgeCode: "deadbeef" },
    });
    await createSession(picker.userId);

    const users = await listUsers(db, admin);
    const ana = users.find((u) => u.id === picker.userId);
    expect(ana).toMatchObject({
      name: "Ana",
      roles: ["PICKER"],
      active: true,
      hasPin: true,
      hasBadge: true,
      pinLockedUntil: null,
    });
    expect(ana?.lastActiveAt).toBeInstanceOf(Date);
    expect(users.find((u) => u.id === admin.userId)).toMatchObject({
      hasPin: false,
      hasBadge: false,
      lastActiveAt: null,
    });
    const serialized = JSON.stringify(users);
    expect(serialized).not.toContain("scrypt$salt$hash");
    expect(serialized).not.toContain("deadbeef");
  });
});

describe("updateUserRoles", () => {
  it("replaces roles and audits before and after", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const target = await createActor(db, ["PICKER"]);

    const updated = await updateUserRoles(db, admin, {
      id: target.userId,
      roles: ["PACKER", "QA"],
    });
    expect(updated.roles).toEqual(["PACKER", "QA"]);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: target.userId } });
    expect(audit).toMatchObject({
      entityType: "User",
      action: "user.roles.update",
      actorId: admin.userId,
      before: { roles: ["PICKER"] },
      after: { roles: ["PACKER", "QA"] },
    });
  });

  it("requires at least one role", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const target = await createActor(db, ["PICKER"]);
    await expect(
      updateUserRoles(db, admin, { id: target.userId, roles: [] }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.users.rolesRequired" });
  });

  it("refuses removing your own Admin role, but lets you add others", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createActor(db, ["ADMIN"]);
    await expect(
      updateUserRoles(db, admin, { id: admin.userId, roles: ["PICKER"] }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.self" });

    const updated = await updateUserRoles(db, admin, {
      id: admin.userId,
      roles: ["ADMIN", "PICKER"],
    });
    expect(updated.roles).toEqual(["ADMIN", "PICKER"]);
  });

  it("refuses demoting the only active Admin", async () => {
    // The acting admin's own row lost Admin since their request began; the target is the last one.
    const actor = await createActor(db, ["ADMIN"]);
    await db.user.update({ where: { id: actor.userId }, data: { roles: ["PICKER"] } });
    const lastAdmin = await createActor(db, ["ADMIN"]);

    await expect(
      updateUserRoles(db, actor, { id: lastAdmin.userId, roles: ["PACKER"] }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.lastAdmin" });
    const row = await db.user.findUniqueOrThrow({ where: { id: lastAdmin.userId } });
    expect(row.roles).toEqual(["ADMIN"]);
  });

  it("never leaves no Admin when two admins demote each other at once", async () => {
    const a = await createActor(db, ["ADMIN"]);
    const b = await createActor(db, ["ADMIN"]);
    const results = await Promise.allSettled([
      updateUserRoles(db, a, { id: b.userId, roles: ["PICKER"] }),
      updateUserRoles(db, b, { id: a.userId, roles: ["PICKER"] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { messageKey: "errors.users.lastAdmin" },
    });
    expect(await db.user.count({ where: { active: true, roles: { has: "ADMIN" } } })).toBe(1);
  });

  it("is not found for an unknown user", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      updateUserRoles(db, admin, { id: crypto.randomUUID(), roles: ["PICKER"] }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("deactivateUser and reactivateUser", () => {
  it("deactivates, deletes every session, ends station activations, and audits", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    await createSession(packer.userId);
    await createSession(packer.userId);
    const keep = await createSession(admin.userId);
    const station = await createStation("Pack 2");
    const activation = await db.stationActivation.create({
      data: { stationId: station.id, userId: packer.userId, method: "PIN" },
    });

    const result = await deactivateUser(db, admin, { id: packer.userId });
    expect(result.active).toBe(false);
    expect(await db.session.count({ where: { userId: packer.userId } })).toBe(0);
    expect(await db.session.findUnique({ where: { id: keep.id } })).not.toBeNull();
    expect(
      await db.stationActivation.findUniqueOrThrow({ where: { id: activation.id } }),
    ).toMatchObject({ endReason: "MANUAL", endedAt: expect.any(Date) });

    const actions = await db.auditEvent.findMany({
      where: { entityId: packer.userId },
      orderBy: { at: "asc" },
    });
    expect(actions.map((a) => a.action)).toEqual(["user.deactivate"]);
  });

  it("is idempotent", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    await deactivateUser(db, admin, { id: packer.userId });
    const again = await deactivateUser(db, admin, { id: packer.userId });
    expect(again.active).toBe(false);
    expect(await db.auditEvent.count({ where: { entityId: packer.userId } })).toBe(1);
  });

  it("refuses deactivating yourself", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createActor(db, ["ADMIN"]);
    await expect(deactivateUser(db, admin, { id: admin.userId })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.users.self",
    });
  });

  it("refuses deactivating the only active Admin", async () => {
    const actor = await createActor(db, ["ADMIN"]);
    await db.user.update({ where: { id: actor.userId }, data: { roles: ["PICKER"] } });
    const lastAdmin = await createActor(db, ["ADMIN"]);
    await expect(deactivateUser(db, actor, { id: lastAdmin.userId })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.users.lastAdmin",
    });
  });

  it("reactivates and audits; reactivating an active user changes nothing", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    await deactivateUser(db, admin, { id: packer.userId });

    expect((await reactivateUser(db, admin, { id: packer.userId })).active).toBe(true);
    expect((await reactivateUser(db, admin, { id: packer.userId })).active).toBe(true);
    const actions = await db.auditEvent.findMany({
      where: { entityId: packer.userId },
      orderBy: { at: "asc" },
    });
    expect(actions.map((a) => a.action)).toEqual(["user.deactivate", "user.reactivate"]);
  });
});

describe("permissions", () => {
  it.each(nonAdmins)("forbids %s from every users procedure", async (role) => {
    const actor: UserActor = await createActor(db, [role]);
    const target = await createActor(db, ["PICKER"]);
    const id = target.userId;
    for (const call of [
      () => listUsers(db, actor),
      () => updateUserRoles(db, actor, { id, roles: ["PACKER"] }),
      () => deactivateUser(db, actor, { id }),
      () => reactivateUser(db, actor, { id }),
    ]) {
      await expect(call()).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
    expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({
      active: true,
      roles: ["PICKER"],
    });
  });
});
