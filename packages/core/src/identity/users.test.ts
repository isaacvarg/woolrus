import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { raceBehindLock } from "../../test/locks";
import type { UserActor } from "../permissions";
import { isStationOnly } from "./station-only";
import { stationStatus, unlockWithPin } from "./station-session";
import { findStationByToken, registerStation } from "./stations";
import {
  createStationUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  updateUserRoles,
} from "./users";

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

    const { users } = await listUsers(db, admin);
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

  it("searches name or email in any case, and pages in name order", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await db.user.update({ where: { id: admin.userId }, data: { name: "Zed Admin" } });
    for (const name of ["Ana Lopez", "Bo Ana", "Cy", "Dee"]) {
      const { userId } = await createActor(db, ["PICKER"]);
      await db.user.update({ where: { id: userId }, data: { name } });
    }
    const { userId: byEmail } = await createActor(db, ["PICKER"]);
    await db.user.update({
      where: { id: byEmail },
      data: { name: "Eve", email: "ANA.mail@example.test" },
    });

    const found = await listUsers(db, admin, { search: " ana " });
    expect(found.users.map((u) => u.name)).toEqual(["Ana Lopez", "Bo Ana", "Eve"]);
    expect(found.total).toBe(3);

    const page2 = await listUsers(db, admin, { page: 2, pageSize: 2 });
    expect(page2).toMatchObject({ total: 6, page: 2, pageSize: 2 });
    expect(page2.users.map((u) => u.name)).toEqual(["Cy", "Dee"]);
    expect((await listUsers(db, admin, { pageSize: 500 })).pageSize).toBe(100);
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

  it("an inactive Admin doesn't count toward keeping one", async () => {
    // As above, the actor lost Admin mid-request; an old Admin account sits deactivated.
    const actor = await createActor(db, ["ADMIN"]);
    await db.user.update({ where: { id: actor.userId }, data: { roles: ["PICKER"] } });
    const gone = await createActor(db, ["ADMIN"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });
    const lastAdmin = await createActor(db, ["ADMIN"]);

    await expect(
      updateUserRoles(db, actor, { id: lastAdmin.userId, roles: ["PACKER"] }),
    ).rejects.toMatchObject({ messageKey: "errors.users.lastAdmin" });
    await expect(deactivateUser(db, actor, { id: lastAdmin.userId })).rejects.toMatchObject({
      messageKey: "errors.users.lastAdmin",
    });
  });

  it("never leaves no Admin when two admins demote each other at once", async () => {
    const a = await createActor(db, ["ADMIN"]);
    const b = await createActor(db, ["ADMIN"]);
    const results = await raceBehindLock(
      db,
      { table: "users", ids: [a.userId, b.userId], waiters: 2 },
      () => [
        updateUserRoles(db, a, { id: b.userId, roles: ["PICKER"] }),
        updateUserRoles(db, b, { id: a.userId, roles: ["PICKER"] }),
      ],
    );
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
      () =>
        createStationUser(db, actor, {
          name: "Luis",
          roles: ["PICKER"],
          pin: PIN,
          idempotencyKey: crypto.randomUUID(),
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
    expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({
      active: true,
      roles: ["PICKER"],
    });
    expect(await db.user.count({ where: { name: "Luis" } })).toBe(0);
  });
});

// --- Station-only users (SPEC-identity amendment 1, success criteria 16, 17, 19) ---

const PIN = "482916";

function stationUserInput(overrides: Partial<Parameters<typeof createStationUser>[2]> = {}) {
  return {
    name: "Luis",
    roles: ["PICKER"] as Role[],
    pin: PIN,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

describe("isStationOnly", () => {
  it("is true only for the reserved station.invalid domain, in any case", () => {
    expect(isStationOnly(`${crypto.randomUUID()}@station.invalid`)).toBe(true);
    expect(isStationOnly("X@STATION.INVALID")).toBe(true);
    expect(isStationOnly("luis@example.test")).toBe(false);
    expect(isStationOnly("luis@station.invalid.example.test")).toBe(false);
    expect(isStationOnly("luis@notstation.invalid")).toBe(false);
  });
});

describe("createStationUser", () => {
  it("creates an active user with a PIN who gets a tile and unlocks with that PIN", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const created = await createStationUser(db, admin, stationUserInput({ name: "  Luis  " }));

    expect(created).toMatchObject({
      name: "Luis",
      email: null,
      stationOnly: true,
      roles: ["PICKER"],
      active: true,
      hasPin: true,
      hasBadge: false,
    });
    const row = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(isStationOnly(row.email)).toBe(true);
    expect(row.emailVerified).toBe(false);

    const { token } = await registerStation(db, admin, { name: "Pick 1" });
    const station = await findStationByToken(db, token);
    if (!station) throw new Error("expected the station");
    const status = await stationStatus(db, station);
    expect(status.tiles).toContainEqual({ id: created.id, name: "Luis", initials: "L" });
    await expect(unlockWithPin(db, station, { userId: created.id, pin: PIN })).resolves.toEqual({
      userName: "Luis",
    });
  });

  it("writes one user.create audit with stationOnly and roles, never the PIN or its hash", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const created = await createStationUser(db, admin, stationUserInput());
    const row = await db.user.findUniqueOrThrow({ where: { id: created.id } });

    const audit = await db.auditEvent.findMany({ where: { entityId: created.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "user.create",
      entityType: "User",
      actorId: admin.userId,
      after: { stationOnly: true, roles: ["PICKER"] },
    });
    const json = JSON.stringify(audit);
    expect(json).not.toContain(PIN);
    expect(json).not.toContain(row.pinHash ?? "no hash");
    expect(json).not.toContain(row.email);
  });

  it("creates one user for the same idempotency key twice", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const input = stationUserInput();
    const first = await createStationUser(db, admin, input);
    const second = await createStationUser(db, admin, input);
    expect(second.id).toBe(first.id);
    expect(second.lastActiveAt).toBeNull();
    expect(await db.user.count({ where: { name: "Luis" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "user.create" } })).toBe(1);
  });

  it("refuses the Admin role", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      createStationUser(db, admin, stationUserInput({ roles: ["PICKER", "ADMIN"] })),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.users.stationOnlyAdmin" });
    expect(await db.user.count({ where: { name: "Luis" } })).toBe(0);
  });

  it("validates the name, roles and PIN", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    for (const overrides of [
      { name: "   " },
      { name: "x".repeat(81) },
      { roles: [] as Role[] },
      { pin: "12345" },
      { pin: "123456" },
    ]) {
      await expect(createStationUser(db, admin, stationUserInput(overrides))).rejects.toMatchObject(
        {
          kind: "BAD_REQUEST",
        },
      );
    }
    await expect(
      createStationUser(db, admin, stationUserInput({ name: "x".repeat(80) })),
    ).resolves.toMatchObject({ stationOnly: true });
  });

  it("allows the same name as another user (the dialog only warns)", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createStationUser(db, admin, stationUserInput());
    await createStationUser(db, admin, stationUserInput({ name: "luis" }));
    expect(await db.user.count({ where: { name: { equals: "luis", mode: "insensitive" } } })).toBe(
      2,
    );
  });
});

describe("station-only users in the other users procedures", () => {
  it("updateUserRoles refuses adding Admin to a station-only user, but allows other roles", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { id } = await createStationUser(db, admin, stationUserInput());
    await expect(
      updateUserRoles(db, admin, { id, roles: ["PICKER", "ADMIN"] }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.users.stationOnlyAdmin" });
    await expect(updateUserRoles(db, admin, { id, roles: ["PACKER"] })).resolves.toMatchObject({
      roles: ["PACKER"],
      email: null,
      stationOnly: true,
    });
  });

  it("listUsers returns email null and never matches the placeholder in search", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const created = await createStationUser(db, admin, stationUserInput());
    const row = await db.user.findUniqueOrThrow({ where: { id: created.id } });

    const all = await listUsers(db, admin);
    expect(all.users.find((u) => u.id === created.id)).toMatchObject({
      email: null,
      stationOnly: true,
    });
    expect(all.users.find((u) => u.id === admin.userId)).toMatchObject({ stationOnly: false });
    expect(JSON.stringify(all)).not.toContain("station.invalid");

    for (const search of ["station.invalid", "invalid", row.email.slice(0, 8), "@"]) {
      const found = await listUsers(db, admin, { search });
      expect(found.users.map((u) => u.id)).not.toContain(created.id);
    }
    expect((await listUsers(db, admin, { search: "lui" })).users.map((u) => u.id)).toEqual([
      created.id,
    ]);
  });
});
