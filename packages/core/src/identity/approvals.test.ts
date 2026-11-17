import type { ApprovalInput } from "@woolrus/contracts";
import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { systemActor, type UserActor } from "../permissions";
import { listApprovers, recordApproval, verifyApprover } from "./approvals";
import { hashBadgeCode, hashPin } from "./credentials";
import { stationActor, unlockWithPin } from "./station-session";
import { findStationByToken, registerStation } from "./stations";

// SPEC-identity A2, success criteria 23–26. Proven through a throwaway action that takes an
// approval, so the mechanism is tested end to end without packing.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const PIN = "482916";
const WRONG = "111112";
const NOW = new Date("2026-11-12T10:00:00Z");

function never(): never {
  throw new Error("expected a value");
}

/** Someone with a PIN and a badge. */
async function person(name: string, roles: Role[]) {
  const actor = await createActor(db, roles);
  const badge = `WRB-${name.toUpperCase()}`;
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

/** A packer acting from a station, as the station resolves them. */
async function packerOnStation() {
  const packer = await person("Pat", ["PACKER"]);
  const station = await newStation();
  await unlockWithPin(db, station, { userId: packer.userId, pin: PIN }, NOW);
  const resolved = (await stationActor(db, station, NOW)) ?? never();
  return { packer, station, actor: resolved.actor };
}

/**
 * The throwaway action: "approve" an order by bumping its version, as a real action would move it.
 * Credentials first (counted even when the action fails), then the action's own transaction with
 * its checks, the approval row and the change.
 */
async function approvedBump(
  actor: UserActor,
  input: { orderId: string; expectedVersion: number; approval: ApprovalInput },
  now = NOW,
): Promise<string> {
  const { approverId } = await verifyApprover(db, actor, {
    credential: input.approval.credential,
    permission: "order.qa",
    now,
  });
  return db.$transaction(async (tx) => {
    const approvalId = await recordApproval(tx, actor, {
      approverId,
      permission: "order.qa",
      kind: "PACKING_CHECKS",
      entityType: "Order",
      entityId: input.orderId,
      reason: input.approval.reason,
      details: { checks: ["boxTooSmall"] },
      now,
    });
    // The action's own check comes after recordApproval here on purpose (criterion 26).
    const { count } = await tx.order.updateMany({
      where: { id: input.orderId, version: input.expectedVersion },
      data: { version: { increment: 1 } },
    });
    if (count === 0) throw new AppError("CONFLICT", "errors.workflow.stale");
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: input.orderId,
      orderId: input.orderId,
      action: "order.hold",
      at: now,
    });
    return approvalId;
  });
}

const reason = "pail is in the large box, rate checked";

async function nothingWritten(orderId: string, version = 1) {
  expect(await db.approval.count()).toBe(0);
  expect(
    await db.auditEvent.count({ where: { action: { in: ["approval.grant", "order.hold"] } } }),
  ).toBe(0);
  expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).version).toBe(version);
}

describe("approvals: happy path (criterion 23)", () => {
  it("a QA user's PIN from a station writes one Approval row and one approval.grant audit", async () => {
    const { packer, station, actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const { order } = await createOrder(db);

    const approvalId = await approvedBump(actor, {
      orderId: order.id,
      expectedVersion: 1,
      approval: { credential: { userId: maria.userId, pin: PIN }, reason: `  ${reason} ` },
    });

    const rows = await db.approval.findMany();
    expect(rows).toEqual([
      expect.objectContaining({
        id: approvalId,
        kind: "PACKING_CHECKS",
        entityType: "Order",
        entityId: order.id,
        requestedById: packer.userId,
        approvedById: maria.userId,
        stationId: station.id,
        reason,
        details: { checks: ["boxTooSmall"] },
        createdAt: NOW,
      }),
    ]);
    const audits = await db.auditEvent.findMany({ where: { action: "approval.grant" } });
    expect(audits).toEqual([
      expect.objectContaining({
        entityType: "Approval",
        entityId: approvalId,
        actorId: packer.userId,
        stationId: station.id,
        after: {
          approvalId,
          kind: "PACKING_CHECKS",
          approvedById: maria.userId,
          entityType: "Order",
          entityId: order.id,
          reason: expect.any(String),
        },
      }),
    ]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
  });

  it("works from a desktop session, and with a badge the same as a PIN", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const maria = await person("Maria", ["QA"]);
    const { order } = await createOrder(db);

    await approvedBump(packer, {
      orderId: order.id,
      expectedVersion: 1,
      approval: { credential: { badgeCode: maria.badge.toLowerCase() }, reason },
    });

    expect(await db.approval.findMany()).toEqual([
      expect.objectContaining({
        requestedById: packer.userId,
        approvedById: maria.userId,
        stationId: null,
      }),
    ]);
    expect(await db.auditEvent.count({ where: { action: "approval.grant" } })).toBe(1);
  });

  it("an Admin approves too, but only with a PIN or badge of their own", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const admin = await person("Ada", ["ADMIN"]);
    await expect(
      verifyApprover(db, packer, {
        credential: { userId: admin.userId, pin: PIN },
        permission: "order.qa",
        now: NOW,
      }),
    ).resolves.toEqual({ approverId: admin.userId });
  });
});

describe("approvals: shared lockout (criterion 24)", () => {
  it("4 wrong approval PINs + 1 wrong lock-screen PIN lock the PIN for 15 minutes on both", async () => {
    const { actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const elsewhere = await newStation("Pick 1");
    const { order } = await createOrder(db);
    const attempt = (pin: string, now = NOW) =>
      approvedBump(
        actor,
        {
          orderId: order.id,
          expectedVersion: 1,
          approval: { credential: { userId: maria.userId, pin }, reason },
        },
        now,
      );

    for (let i = 0; i < 4; i++) {
      await expect(attempt(WRONG)).rejects.toMatchObject({
        kind: "UNAUTHORIZED",
        messageKey: "errors.station.badPin",
      });
      await nothingWritten(order.id);
    }
    const until = new Date(NOW.getTime() + 15 * 60_000);
    await expect(
      unlockWithPin(db, elsewhere, { userId: maria.userId, pin: WRONG }, NOW),
    ).rejects.toMatchObject({
      messageKey: "errors.station.pinLocked",
      params: { until: until.toISOString() },
    });

    // Locked on both, even with the right PIN, until it expires.
    const later = new Date(until.getTime() - 1000);
    await expect(attempt(PIN, later)).rejects.toMatchObject({
      messageKey: "errors.station.pinLocked",
    });
    await expect(
      unlockWithPin(db, elsewhere, { userId: maria.userId, pin: PIN }, later),
    ).rejects.toMatchObject({ messageKey: "errors.station.pinLocked" });
    await nothingWritten(order.id);
    await attempt(PIN, until);
    expect(await db.approval.count()).toBe(1);
  });

  it("a correct approval PIN resets the count the lock screen sees", async () => {
    const { actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const verify = (pin: string) =>
      verifyApprover(db, actor, {
        credential: { userId: maria.userId, pin },
        permission: "order.qa",
        now: NOW,
      });

    for (let i = 0; i < 4; i++) await expect(verify(WRONG)).rejects.toBeInstanceOf(AppError);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: maria.userId } })).pinFailedAttempts,
    ).toBe(4);
    await verify(PIN);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: maria.userId } })).pinFailedAttempts,
    ).toBe(0);
  });

  it("gives the same badPin for a wrong PIN, an unknown user and a user without a PIN", async () => {
    const { actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const noPin = await createActor(db, ["QA"]);
    for (const credential of [
      { userId: maria.userId, pin: WRONG },
      { userId: maria.userId, pin: "not a pin" },
      { userId: crypto.randomUUID(), pin: PIN },
      { userId: noPin.userId, pin: PIN },
    ]) {
      await expect(
        verifyApprover(db, actor, { credential, permission: "order.qa", now: NOW }),
      ).rejects.toMatchObject({ kind: "UNAUTHORIZED", messageKey: "errors.station.badPin" });
    }
  });

  it("refuses an unknown badge with badBadge", async () => {
    const { actor } = await packerOnStation();
    await expect(
      verifyApprover(db, actor, {
        credential: { badgeCode: "WRB-NOBODY" },
        permission: "order.qa",
        now: NOW,
      }),
    ).rejects.toMatchObject({ kind: "UNAUTHORIZED", messageKey: "errors.station.badBadge" });
  });
});

describe("approvals: refusals (criterion 25)", () => {
  it("refuses an approver who lacks the permission, and writes nothing", async () => {
    const { actor } = await packerOnStation();
    const picker = await person("Bo", ["PICKER", "PACKER"]);
    const { order } = await createOrder(db);
    for (const credential of [{ userId: picker.userId, pin: PIN }, { badgeCode: picker.badge }]) {
      await expect(
        approvedBump(actor, {
          orderId: order.id,
          expectedVersion: 1,
          approval: { credential, reason },
        }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN", messageKey: "errors.approval.notPermitted" });
    }
    await nothingWritten(order.id);
  });

  it("refuses a deactivated approver, by PIN or badge, and writes nothing", async () => {
    const { actor } = await packerOnStation();
    const gone = await person("Gone", ["QA"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });
    const { order } = await createOrder(db);
    // Like the lock screen: a deactivated user's credential is just a bad one.
    await expect(
      approvedBump(actor, {
        orderId: order.id,
        expectedVersion: 1,
        approval: { credential: { userId: gone.userId, pin: PIN }, reason },
      }),
    ).rejects.toMatchObject({ messageKey: "errors.station.badPin" });
    await expect(
      approvedBump(actor, {
        orderId: order.id,
        expectedVersion: 1,
        approval: { credential: { badgeCode: gone.badge }, reason },
      }),
    ).rejects.toMatchObject({ messageKey: "errors.station.badBadge" });
    await nothingWritten(order.id);
  });

  it("re-checks in the action's transaction: deactivated or demoted since verifying is refused", async () => {
    const { actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const { order } = await createOrder(db);
    const { approverId } = await verifyApprover(db, actor, {
      credential: { userId: maria.userId, pin: PIN },
      permission: "order.qa",
      now: NOW,
    });
    const record = () =>
      db.$transaction((tx) =>
        recordApproval(tx, actor, {
          approverId,
          permission: "order.qa",
          kind: "PACKING_CHECKS",
          entityType: "Order",
          entityId: order.id,
          reason,
          details: {},
          now: NOW,
        }),
      );

    await db.user.update({ where: { id: maria.userId }, data: { active: false } });
    await expect(record()).rejects.toMatchObject({
      kind: "FORBIDDEN",
      messageKey: "errors.approval.notPermitted",
    });
    await db.user.update({
      where: { id: maria.userId },
      data: { active: true, roles: ["PACKER"] },
    });
    await expect(record()).rejects.toMatchObject({ messageKey: "errors.approval.notPermitted" });
    await nothingWritten(order.id);
  });

  it("never lets the requester approve their own request, from a station or a desk", async () => {
    const qa = await person("Quinn", ["QA"]);
    const station = await newStation();
    await unlockWithPin(db, station, { userId: qa.userId, pin: PIN }, NOW);
    const onStation = (await stationActor(db, station, NOW))?.actor ?? never();
    const { order } = await createOrder(db);
    for (const actor of [onStation, { ...qa, stationId: null }]) {
      for (const credential of [{ userId: qa.userId, pin: PIN }, { badgeCode: qa.badge }]) {
        await expect(
          approvedBump(actor, {
            orderId: order.id,
            expectedVersion: 1,
            approval: { credential, reason },
          }),
        ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.approval.self" });
      }
    }
    // recordApproval refuses it too, without a verify first.
    await expect(
      db.$transaction((tx) =>
        recordApproval(tx, onStation, {
          approverId: qa.userId,
          permission: "order.qa",
          kind: "PACKING_CHECKS",
          entityType: "Order",
          entityId: order.id,
          reason,
          details: {},
          now: NOW,
        }),
      ),
    ).rejects.toMatchObject({ messageKey: "errors.approval.self" });
    await nothingWritten(order.id);
  });

  it("requires a reason of 1 to 200 characters after trimming, and writes nothing", async () => {
    const { actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const { order } = await createOrder(db);
    for (const bad of ["", "   ", "x".repeat(201)]) {
      await expect(
        approvedBump(actor, {
          orderId: order.id,
          expectedVersion: 1,
          approval: { credential: { userId: maria.userId, pin: PIN }, reason: bad },
        }),
      ).rejects.toMatchObject({
        kind: "BAD_REQUEST",
        messageKey: "errors.approval.reasonRequired",
      });
    }
    await nothingWritten(order.id);
    await approvedBump(actor, {
      orderId: order.id,
      expectedVersion: 1,
      approval: { credential: { userId: maria.userId, pin: PIN }, reason: "x".repeat(200) },
    });
    expect(await db.approval.count()).toBe(1);
  });

  it("the database refuses requester = approver on its own (CHECK)", async () => {
    const qa = await person("Quinn", ["QA"]);
    const { order } = await createOrder(db);
    await expect(
      db.approval.create({
        data: {
          kind: "PACKING_CHECKS",
          entityType: "Order",
          entityId: order.id,
          requestedById: qa.userId,
          approvedById: qa.userId,
          reason,
        },
      }),
    ).rejects.toThrow(/approvals_not_self/);
  });
});

describe("approvals: atomic with the action (criterion 26)", () => {
  it("rolls the Approval row and its audit back when the action fails after recordApproval", async () => {
    const { actor } = await packerOnStation();
    const maria = await person("Maria", ["QA"]);
    const { order } = await createOrder(db);

    await expect(
      approvedBump(actor, {
        orderId: order.id,
        expectedVersion: 7, // stale
        approval: { credential: { userId: maria.userId, pin: PIN }, reason },
      }),
    ).rejects.toMatchObject({ messageKey: "errors.workflow.stale" });

    await nothingWritten(order.id);
  });
});

describe("approver tiles (criterion 27)", () => {
  it("lists active users with the permission and a PIN, by name, never the caller", async () => {
    const { actor, packer } = await packerOnStation();
    await person("Zoe", ["QA"]);
    const maria = await person("Maria", ["QA"]);
    const admin = await person("Ana", ["ADMIN"]);
    await person("Pete", ["PACKER"]); // no order.qa
    const gone = await person("Gus", ["QA"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });
    const noPin = await person("Nell", ["QA"]);
    await db.user.update({ where: { id: noPin.userId }, data: { pinHash: null } });

    const tiles = await listApprovers(db, actor, { permission: "order.qa" });

    expect(tiles.map((t) => t.name)).toEqual(["Ana", "Maria", "Zoe"]);
    expect(tiles.find((t) => t.name === "Maria")).toEqual({
      id: maria.userId,
      name: "Maria",
      initials: "M",
    });
    expect(tiles.map((t) => t.id)).not.toContain(packer.userId);
    expect(tiles.map((t) => t.id)).toContain(admin.userId);
  });

  it("leaves out the caller even when they could approve, from a desk too", async () => {
    const qa = await person("Quinn", ["QA"]);
    await person("Maria", ["QA"]);
    const desk = { userId: qa.userId, roles: qa.roles, stationId: null };

    const tiles = await listApprovers(db, desk, { permission: "order.qa" });

    expect(tiles.map((t) => t.name)).toEqual(["Maria"]);
  });

  it("refuses an unknown permission and a background job", async () => {
    const qa = await person("Quinn", ["QA"]);
    await expect(listApprovers(db, qa, { permission: "order.fly" })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
    await expect(listApprovers(db, systemActor, { permission: "order.qa" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});
