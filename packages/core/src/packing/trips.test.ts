import type { ApprovalInput } from "@woolrus/contracts";
import type { Db, PackCheckMode } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type PackageSpec } from "../../test/factories";
import { hashPin } from "../identity/credentials";
import type { UserActor } from "../permissions";
import { repackOrders } from "../shipping/repack";
import { forceStatus } from "../workflow/service";
import { completePack } from "./complete";
import { packCheckStats } from "./trips";

// SPEC-packing A1 criteria 21, 22, 26, 27: trips saved when an order leaves Packing.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

type Modes = Partial<
  Record<
    | "packCheckOverMax"
    | "packCheckWeightOff"
    | "packCheckWeightStale"
    | "packCheckNoFit"
    | "packCheckCustomDimensions",
    PackCheckMode
  >
>;
const setModes = (modes: Modes) =>
  db.settings.upsert({ where: { id: 1 }, create: { id: 1, ...modes }, update: modes });

const tripsOf = (orderId: string) =>
  db.packageCheckTrip.findMany({
    where: { package: { orderId } },
    orderBy: [{ package: { number: "asc" } }, { check: "asc" }],
    include: { package: { select: { number: true } } },
  });
const summary = async (orderId: string) =>
  (await tripsOf(orderId)).map((t) => ({ number: t.package.number, check: t.check, mode: t.mode }));

/**
 * A Packing order claimed by a packer, with:
 * - package 1 in a box with a 30 oz max, weighed 36 oz with a reason and flagged re-weigh
 *   (OVER_MAX, WEIGHT_STALE);
 * - package 2 a custom size (CUSTOM_DIMENSIONS);
 * - package 3 clean.
 */
async function tripping(status: "PACKING" | "QA" | "READY" = "PACKING") {
  const packer = await createActor(db, ["PACKER"]);
  const packages: PackageSpec[] = [
    { items: [{ line: 0, quantity: 1 }], weightOz: 36 },
    {
      items: [{ line: 0, quantity: 1 }],
      boxed: false,
      dimensions: { lengthIn: 5, widthIn: 5, heightIn: 5 },
      weightOz: 10,
    },
    { items: [{ line: 0, quantity: 1 }], weightOz: 8 },
  ];
  const built = await createOrder(db, {
    status,
    version: 3,
    claimedById: status === "PACKING" ? packer.userId : null,
    claimedAt: new Date(),
    lines: [{ quantity: 3, pickStatus: "PICKED" }],
    packages,
  });
  const box = await db.box.create({
    data: {
      name: `Capped ${crypto.randomUUID()}`,
      lengthIn: 10,
      widthIn: 10,
      heightIn: 10,
      maxWeightOz: 30,
    },
  });
  await db.package.update({
    where: { id: built.packages[0]?.id },
    data: { boxId: box.id, weightOverrideReason: "Dense kit", weightStale: true },
  });
  return { packer, ...built };
}

const finish = (packer: UserActor, orderId: string, approval?: ApprovalInput) =>
  completePack(db, packer, { orderId, expectedVersion: 3, after: "queue", approval });

/** A QA user's approval, as a blocking trip needs (SPEC-packing A1). */
async function qaApproval(): Promise<ApprovalInput> {
  const qa = await createActor(db, ["QA"]);
  await db.user.update({ where: { id: qa.userId }, data: { pinHash: await hashPin("482916") } });
  return { credential: { userId: qa.userId, pin: "482916" }, reason: "Checked it" };
}

describe("completing packing saves the trips", () => {
  it("writes exactly one row per WARN or BLOCK trip, with its details", async () => {
    await setModes({ packCheckCustomDimensions: "BLOCK" });
    const { packer, order } = await tripping();

    await finish(packer, order.id, await qaApproval());

    expect(await summary(order.id)).toEqual([
      { number: 1, check: "OVER_MAX", mode: "WARN" },
      { number: 1, check: "WEIGHT_STALE", mode: "WARN" },
      { number: 2, check: "CUSTOM_DIMENSIONS", mode: "BLOCK" },
    ]);
    const [overMax] = await tripsOf(order.id);
    expect(overMax).toMatchObject({
      details: { weightOz: 36, maxOz: 30, reason: "Dense kit" },
      approvalId: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    });
    // The blocking row points at the approval that let it through; the warnings don't.
    const approval = await db.approval.findFirstOrThrow();
    expect((await tripsOf(order.id)).map((t) => t.approvalId)).toEqual([null, null, approval.id]);
  });

  it("writes none for checks set to off", async () => {
    await setModes({ packCheckWeightStale: "OFF", packCheckCustomDimensions: "OFF" });
    const { packer, order } = await tripping();

    await finish(packer, order.id);

    expect(await summary(order.id)).toEqual([{ number: 1, check: "OVER_MAX", mode: "WARN" }]);
  });

  it("writes nothing when the gate refuses the move", async () => {
    const { packer, order, packages } = await tripping();
    await db.package.update({ where: { id: packages[2]?.id }, data: { weightOz: null } });

    await expect(finish(packer, order.id)).rejects.toMatchObject({ kind: "CONFLICT" });

    expect(await tripsOf(order.id)).toEqual([]);
  });

  it("force-status from Packing to QA writes them too", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await tripping();

    await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: 3,
      to: "QA",
      reason: "Packer went home",
    });

    expect((await summary(order.id)).map((t) => t.check)).toEqual([
      "OVER_MAX",
      "WEIGHT_STALE",
      "CUSTOM_DIMENSIONS",
    ]);
  });

  it("force-status to QA from a hold placed in Packing writes them too (decision 16)", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await tripping();
    await db.order.update({
      where: { id: order.id },
      data: { status: "ON_HOLD", heldFromStatus: "PACKING", claimedById: null },
    });

    await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: 3,
      to: "QA",
      reason: "Released straight to QA",
    });

    expect((await summary(order.id)).map((t) => t.check)).toEqual([
      "OVER_MAX",
      "WEIGHT_STALE",
      "CUSTOM_DIMENSIONS",
    ]);
  });

  it("a mode changed while the order is in QA leaves its trips unchanged", async () => {
    const { packer, order } = await tripping();
    await finish(packer, order.id);
    const before = await tripsOf(order.id);

    await setModes({
      packCheckWeightStale: "OFF",
      packCheckCustomDimensions: "BLOCK",
      packCheckNoFit: "BLOCK",
    });

    expect(await tripsOf(order.id)).toEqual(before);
  });
});

describe("going back to Packing deletes them", () => {
  it("force-status back to Packing deletes the order's trips and no one else's", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { packer, order } = await tripping();
    const other = await tripping();
    await finish(packer, order.id);
    await finish(other.packer, other.order.id);
    const confirmed = { boxConfirmedAt: new Date(), boxConfirmedById: admin.userId };
    await db.package.updateMany({
      where: { orderId: { in: [order.id, other.order.id] } },
      data: confirmed,
    });

    await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: 4,
      to: "PACKING",
      reason: "Wrong box",
    });

    expect(await tripsOf(order.id)).toEqual([]);
    expect(await tripsOf(other.order.id)).toHaveLength(3);
    // ...and the box confirmations with them (criterion 21).
    const boxes = (orderId: string) =>
      db.package.findMany({ where: { orderId }, select: { boxConfirmedAt: true } });
    expect((await boxes(order.id)).every((p) => p.boxConfirmedAt === null)).toBe(true);
    expect((await boxes(other.order.id)).every((p) => p.boxConfirmedAt !== null)).toBe(true);
  });

  it("a repack from Ready deletes them", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const { packer, order } = await tripping();
    await finish(packer, order.id);
    await db.order.update({ where: { id: order.id }, data: { status: "READY" } });

    const result = await repackOrders(db, shipper, {
      orderIds: [order.id],
      reason: "Customer changed the scent",
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.orders[0]).toMatchObject({ repacked: true });
    expect(await tripsOf(order.id)).toEqual([]);
  });

  it("completing again saves the trips as they stand then", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { packer, order } = await tripping();
    await finish(packer, order.id);
    await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: 4,
      to: "PACKING",
      reason: "Wrong box",
    });
    await db.order.update({
      where: { id: order.id },
      data: { claimedById: packer.userId, claimedAt: new Date() },
    });
    await setModes({ packCheckWeightStale: "OFF" });

    await completePack(db, packer, { orderId: order.id, expectedVersion: 5, after: "queue" });

    expect((await summary(order.id)).map((t) => t.check)).toEqual([
      "OVER_MAX",
      "CUSTOM_DIMENSIONS",
    ]);
  });
});

describe("the re-weigh note and the WEIGHT_STALE trip", () => {
  const notesOf = (orderId: string) => db.note.findMany({ where: { orderId } });

  it("with WEIGHT_STALE off, the note is written and no trip saved", async () => {
    await setModes({ packCheckWeightStale: "OFF" });
    const { packer, order } = await tripping();

    await finish(packer, order.id);

    expect(await notesOf(order.id)).toHaveLength(1);
    expect((await summary(order.id)).map((t) => t.check)).not.toContain("WEIGHT_STALE");
  });

  it.each(["WARN", "BLOCK"] as const)(
    "with WEIGHT_STALE on %s, no note is written and the trip carries it",
    async (mode) => {
      await setModes({ packCheckWeightStale: mode });
      const { packer, order } = await tripping();

      await finish(packer, order.id, mode === "BLOCK" ? await qaApproval() : undefined);

      expect(await notesOf(order.id)).toEqual([]);
      expect(await summary(order.id)).toContainEqual({ number: 1, check: "WEIGHT_STALE", mode });
    },
  );
});

describe("packCheckStats", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60_000);

  async function seed() {
    const { packages } = await createOrder(db, {
      status: "QA",
      lines: [{ quantity: 2, pickStatus: "PICKED" }],
      packages: [
        { items: [{ line: 0, quantity: 1 }], weightOz: 10 },
        { items: [{ line: 0, quantity: 1 }], weightOz: 10 },
      ],
    });
    const [a, b] = packages.map((p) => p.id) as [string, string];
    const packer = await createActor(db, ["PACKER"]);
    const qa = await createActor(db, ["QA"]);
    const approval = await db.approval.create({
      data: {
        kind: "PACKING_CHECKS",
        entityType: "Order",
        entityId: crypto.randomUUID(),
        requestedById: packer.userId,
        approvedById: qa.userId,
        reason: "Checked it",
      },
    });
    await db.packageCheckTrip.createMany({
      data: [
        {
          packageId: a,
          check: "NO_FIT",
          mode: "BLOCK",
          approvalId: approval.id,
          createdAt: daysAgo(1),
        },
        { packageId: b, check: "NO_FIT", mode: "WARN", createdAt: daysAgo(29) },
        // Older than 30 days: not counted.
        { packageId: a, check: "OVER_MAX", mode: "WARN", createdAt: daysAgo(31) },
        { packageId: b, check: "WEIGHT_OFF", mode: "WARN", createdAt: daysAgo(30) },
      ],
    });
  }

  it("counts only the last 30 days, per check, with the approved count", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const stats = await packCheckStats(db, admin, { now });

    expect(stats).toEqual([
      { check: "OVER_MAX", trips: 0, approved: 0 },
      { check: "UNDER_MIN", trips: 0, approved: 0 },
      { check: "WEIGHT_OFF", trips: 1, approved: 0 },
      { check: "WEIGHT_STALE", trips: 0, approved: 0 },
      { check: "NO_FIT", trips: 2, approved: 1 },
      { check: "BOX_NOT_SCANNED", trips: 0, approved: 0 },
      { check: "CUSTOM_DIMENSIONS", trips: 0, approved: 0 },
    ]);
  });

  it.each([["QA"], ["PACKER"], ["SHIPPER"]] as const)("is FORBIDDEN for %s", async (role) => {
    const actor = await createActor(db, [role]);

    await expect(packCheckStats(db, actor, { now })).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("the database", () => {
  it("refuses a saved trip in mode OFF", async () => {
    const { packages } = await createOrder(db, {
      status: "QA",
      lines: [{ quantity: 1, pickStatus: "PICKED" }],
      packages: [{ items: [{ line: 0, quantity: 1 }], weightOz: 10 }],
    });

    await expect(
      db.packageCheckTrip.create({
        data: { packageId: packages[0]?.id as string, check: "NO_FIT", mode: "OFF" },
      }),
    ).rejects.toThrow(/package_check_trips_mode_not_off/);
  });
});
