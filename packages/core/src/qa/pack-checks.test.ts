import type { Db, PackCheck, QaBoxConfirm } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { listQueue } from "../workflow/queries";
import { acknowledgeCheck, confirmBox } from "./pack-checks";
import { getQaScreen } from "./queries";

// SPEC-packing A1 criteria 23 and 27: QA acknowledges saved trips and confirms boxes.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const setBoxConfirm = (qaBoxConfirm: QaBoxConfirm) =>
  db.settings.upsert({
    where: { id: 1 },
    create: { id: 1, qaBoxConfirm },
    update: { qaBoxConfirm },
  });

/**
 * A QA order claimed by a QA user, every row verified, with a selected rate per package:
 * package 1 tripped NO_FIT and WEIGHT_OFF, package 2 is clean.
 */
async function inQa(checks: PackCheck[] = ["NO_FIT", "WEIGHT_OFF"]) {
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: "QA",
    claimedById: qa.userId,
    claimedAt: new Date(),
    lines: [{ quantity: 2, pickStatus: "PICKED" }],
    packages: [
      { items: [{ line: 0, quantity: 1, verified: true }], rates: [{ selected: true }] },
      { items: [{ line: 0, quantity: 1, verified: true }], rates: [{ selected: true }] },
    ],
  });
  const [tripped, clean] = built.packages;
  if (!tripped || !clean) throw new Error("no packages");
  const details: Record<PackCheck, object> = {
    NO_FIT: { boxName: "Small", items: ["Pail 5 gal"] },
    WEIGHT_OFF: { weightOz: 40, estimateOz: 20, percent: 100 },
    OVER_MAX: { weightOz: 40, maxOz: 30 },
    WEIGHT_STALE: { weightOz: 40 },
    CUSTOM_DIMENSIONS: { lengthIn: 5, widthIn: 5, heightIn: 5 },
    UNDER_MIN: {},
    BOX_NOT_SCANNED: {},
  };
  await db.packageCheckTrip.createMany({
    data: checks.map((check) => ({
      packageId: tripped.id,
      check,
      mode: "WARN" as const,
      details: details[check],
    })),
  });
  const trips = await db.packageCheckTrip.findMany({ orderBy: { check: "asc" } });
  const trip = (check: PackCheck) => {
    const found = trips.find((t) => t.check === check);
    if (!found) throw new Error(`no ${check} trip`);
    return found;
  };
  return { qa, ...built, tripped, clean, trip };
}

/** The verified gate's part of what stops the labels (no provider is set up in tests). */
const unmetKeys = async (qa: Awaited<ReturnType<typeof inQa>>["qa"], orderId: string) =>
  (await getQaScreen(db, qa, { orderId })).unmet
    .filter((u) => u.messageKey.startsWith("errors.workflow.gate."))
    .map((u) => [u.messageKey, u.params]);

describe("acknowledgeCheck", () => {
  it("acknowledges one trip, audited once however often it's sent", async () => {
    const { qa, trip } = await inQa();
    const id = trip("WEIGHT_OFF").id;

    const result = await acknowledgeCheck(db, qa, { tripId: id });
    await acknowledgeCheck(db, qa, { tripId: id });

    const row = await db.packageCheckTrip.findUniqueOrThrow({ where: { id } });
    expect(row.acknowledgedById).toBe(qa.userId);
    expect(row.acknowledgedAt).not.toBeNull();
    expect(
      await db.auditEvent.count({ where: { action: "packCheckTrip.acknowledge", entityId: id } }),
    ).toBe(1);
    const shown = result.packages[0]?.trips.find((t) => t.id === id);
    expect(shown?.acknowledgedBy).toBeTruthy();
    // The NO_FIT trip is still open.
    expect(
      await db.packageCheckTrip.count({ where: { acknowledgedAt: null, check: "NO_FIT" } }),
    ).toBe(1);
  });

  it("needs order.qa", async () => {
    const { order, trip } = await inQa();
    const packer = await createActor(db, ["PACKER"]);
    await db.order.update({ where: { id: order.id }, data: { claimedById: packer.userId } });
    await expect(acknowledgeCheck(db, packer, { tripId: trip("NO_FIT").id })).rejects.toMatchObject(
      { kind: "FORBIDDEN" },
    );
  });

  it("needs the live claim and the order in QA", async () => {
    const { order, trip } = await inQa();
    const other = await createActor(db, ["QA"]);
    await expect(acknowledgeCheck(db, other, { tripId: trip("NO_FIT").id })).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    await db.order.update({ where: { id: order.id }, data: { status: "READY" } });
    await expect(acknowledgeCheck(db, other, { tripId: trip("NO_FIT").id })).rejects.toMatchObject({
      messageKey: "errors.qa.notQa",
    });
    expect(await db.packageCheckTrip.count({ where: { acknowledgedAt: { not: null } } })).toBe(0);
  });
});

describe("confirmBox", () => {
  it("confirms the box and acknowledges exactly its package's box trips", async () => {
    const { qa, tripped, trip } = await inQa([
      "NO_FIT",
      "OVER_MAX",
      "CUSTOM_DIMENSIONS",
      "WEIGHT_OFF",
      "WEIGHT_STALE",
    ]);

    await confirmBox(db, qa, { packageId: tripped.id });
    await confirmBox(db, qa, { packageId: tripped.id });

    const pkg = await db.package.findUniqueOrThrow({ where: { id: tripped.id } });
    expect(pkg.boxConfirmedById).toBe(qa.userId);
    expect(pkg.boxConfirmedAt).not.toBeNull();
    const acked = await db.packageCheckTrip.findMany({
      where: { acknowledgedAt: { not: null } },
      orderBy: { check: "asc" },
    });
    expect(acked.map((t) => t.check).sort()).toEqual(["CUSTOM_DIMENSIONS", "NO_FIT", "OVER_MAX"]);
    expect(acked.every((t) => t.acknowledgedById === qa.userId)).toBe(true);
    expect(
      (await db.packageCheckTrip.findUniqueOrThrow({ where: { id: trip("WEIGHT_OFF").id } }))
        .acknowledgedAt,
    ).toBeNull();
    expect(
      await db.auditEvent.count({ where: { action: "package.confirmBox", entityId: tripped.id } }),
    ).toBe(1);
  });

  it("is allowed when not required", async () => {
    const { qa, clean } = await inQa();
    const result = await confirmBox(db, qa, { packageId: clean.id });
    expect(result.packages[1]).toMatchObject({ boxConfirmRequired: false });
    expect(result.packages[1]?.boxConfirmed).not.toBeNull();
  });

  it("needs order.qa and the live claim", async () => {
    const { order, tripped } = await inQa();
    const packer = await createActor(db, ["PACKER"]);
    await expect(confirmBox(db, packer, { packageId: tripped.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const other = await createActor(db, ["QA"]);
    await expect(confirmBox(db, other, { packageId: tripped.id })).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    await db.order.update({ where: { id: order.id }, data: { claimedAt: new Date(0) } });
    expect(
      (await db.package.findUniqueOrThrow({ where: { id: tripped.id } })).boxConfirmedAt,
    ).toBeNull();
  });
});

describe("the verified gate and label purchase", () => {
  it("lists the unacknowledged trips and the unconfirmed box until QA clears them", async () => {
    const { qa, order, tripped, trip } = await inQa();
    expect(await unmetKeys(qa, order.id)).toEqual([
      ["errors.workflow.gate.packCheckUnacknowledged", { package: 1, count: 2 }],
      ["errors.workflow.gate.packageBoxUnconfirmed", { package: 1 }],
    ]);

    await confirmBox(db, qa, { packageId: tripped.id });
    expect(await unmetKeys(qa, order.id)).toEqual([
      ["errors.workflow.gate.packCheckUnacknowledged", { package: 1, count: 1 }],
    ]);

    await acknowledgeCheck(db, qa, { tripId: trip("WEIGHT_OFF").id });
    expect(await unmetKeys(qa, order.id)).toEqual([]);
  });

  it.each([
    ["WHEN_TRIPPED", [true, false]],
    ["ALWAYS", [true, true]],
    ["OFF", [false, false]],
  ] as const)("qaBoxConfirm %s: which packages need box confirmation", async (mode, expected) => {
    await setBoxConfirm(mode);
    const { qa, order } = await inQa();
    const view = await getQaScreen(db, qa, { orderId: order.id });
    expect(view.packages.map((p) => p.boxConfirmRequired)).toEqual(expected);
  });
});

describe("the QA view", () => {
  it("shows each trip with how it got through and the box to confirm", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { qa, order, tripped, trip } = await inQa(["NO_FIT", "WEIGHT_OFF"]);
    const approval = await db.approval.create({
      data: {
        kind: "PACKING_CHECKS",
        entityType: "Order",
        entityId: order.id,
        requestedById: qa.userId,
        approvedById: admin.userId,
        reason: "Pail rides on top",
      },
    });
    await db.packageCheckTrip.update({
      where: { id: trip("NO_FIT").id },
      data: { mode: "BLOCK", approvalId: approval.id },
    });

    const view = await getQaScreen(db, qa, { orderId: order.id });
    const pkg = view.packages[0];
    expect(pkg?.id).toBe(tripped.id);
    expect(pkg?.boxConfirmRequired).toBe(true);
    expect(pkg?.boxConfirmed).toBeNull();
    expect(pkg?.trips.map((t) => [t.trip.check, t.approval?.reason ?? null])).toEqual([
      ["WEIGHT_OFF", null],
      ["NO_FIT", "Pail rides on top"],
    ]);
    expect(pkg?.trips[1]?.approval?.approver).toBeTruthy();
    expect(view.packages[1]?.trips).toEqual([]);
  });

  it("marks trips saved by force-status with its reason", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { qa, order, tripped } = await inQa(["NO_FIT"]);
    const at = (await db.packageCheckTrip.findFirstOrThrow({ where: { packageId: tripped.id } }))
      .createdAt;
    await db.orderStageEvent.create({
      data: {
        orderId: order.id,
        fromStatus: "PACKING",
        toStatus: "QA",
        actorId: admin.userId,
        reason: "Packer left; box checked",
        at,
      },
    });

    const view = await getQaScreen(db, qa, { orderId: order.id });
    expect(view.packages[0]?.trips[0]?.forced).toMatchObject({
      reason: "Packer left; box checked",
    });
  });
});

describe("the QA queue", () => {
  it("counts each order's unacknowledged trips", async () => {
    const { qa, order, trip } = await inQa(["NO_FIT", "WEIGHT_OFF", "OVER_MAX"]);
    await createOrder(db, { status: "QA", lines: [{ quantity: 1 }] });
    await acknowledgeCheck(db, qa, { tripId: trip("WEIGHT_OFF").id });

    const page = await listQueue(db, qa, { stage: "QA" });
    const counts = Object.fromEntries(page.rows.map((r) => [r.id, r.packCheckTrips]));
    expect(counts[order.id]).toBe(2);
    expect(Object.values(counts).sort()).toEqual([0, 2]);
  });
});
