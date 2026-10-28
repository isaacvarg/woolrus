import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { verifiedQaOrder } from "../../test/qa-fixtures";
import { listQueue } from "../workflow/queries";
import { completeQaWithLabels } from "./complete";
import { markLabelNotBought, reconcileLabels } from "./labels";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

async function requested(count = 1) {
  const built = await verifiedQaOrder(db, count);
  await completeQaWithLabels(db, built.qa, {
    orderId: built.order.id,
    expectedVersion: built.order.version,
  });
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
  return built;
}

const labelRows = () => db.shippingLabel.findMany({ orderBy: { createdAt: "asc" } });
const queued = () =>
  db.$queryRawUnsafe<{ data: { orderId: string; requestedById: string } }[]>(
    `SELECT data FROM pgboss.job WHERE name = 'labels.purchase' AND state IN ('created', 'retry', 'active')`,
  );

describe("markLabelNotBought", () => {
  async function unknown() {
    const built = await requested(1);
    await db.shippingLabel.updateMany({
      data: { purchaseAttemptedAt: new Date(), error: "errors.qa.purchaseUnknown" },
    });
    const [label] = await labelRows();
    return { ...built, label: label as NonNullable<typeof label> };
  }

  it("releases an unknown purchase: failed, settled manually, reason audited, package can be bought again", async () => {
    const { qa, label, order, packages } = await unknown();

    const result = await markLabelNotBought(db, qa, {
      labelId: label.id,
      reason: "Not in ShipStation",
    });

    expect(await db.shippingLabel.findUniqueOrThrow({ where: { id: label.id } })).toMatchObject({
      status: "PURCHASE_FAILED",
      error: "errors.qa.settledManually",
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: "label.markNotBought" },
    });
    expect(audit).toMatchObject({ entityId: label.id, actorId: qa.userId });
    expect(JSON.stringify(audit.after)).toContain("Not in ShipStation");
    expect(result.purchase).toEqual({ kind: "failed", packages: [packages[0]?.number] });
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const again = await completeQaWithLabels(db, qa, {
      orderId: order.id,
      expectedVersion: fresh.version,
    });
    expect(again.status).toBe("QA");
    expect((await labelRows()).filter((l) => l.status === "PURCHASING")).toHaveLength(1);
  });

  it("refuses a label that isn't an unknown purchase, and changes nothing", async () => {
    const { qa, label } = await requested(1).then(async (b) => ({
      ...b,
      label: (await labelRows())[0] as NonNullable<Awaited<ReturnType<typeof labelRows>>[0]>,
    }));
    await expect(
      markLabelNotBought(db, qa, { labelId: label.id, reason: "x" }),
    ).rejects.toMatchObject({ messageKey: "errors.qa.labelNotUnknown" });
    expect((await labelRows())[0]?.status).toBe("PURCHASING");
  });

  it("is allowed for QA and Admin and forbidden for a Shipper or Packer", async () => {
    const { label } = await unknown();
    for (const role of ["SHIPPER", "PACKER"] as const) {
      const actor = await createActor(db, [role]);
      await expect(
        markLabelNotBought(db, actor, { labelId: label.id, reason: "x" }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
    const admin = await createActor(db, ["ADMIN"]);
    await markLabelNotBought(db, admin, { labelId: label.id, reason: "checked" });
    expect((await labelRows())[0]?.status).toBe("PURCHASE_FAILED");
  });
});

describe("reconcileLabels", () => {
  const now = new Date();
  const old = new Date(now.getTime() - 11 * 60_000);

  it("queues one purchase job for an order with a stale PURCHASING label, and not twice", async () => {
    const { order, qa } = await requested(2);
    await db.shippingLabel.updateMany({ data: { createdAt: old } });

    expect(await reconcileLabels(db, { now })).toBe(1);
    expect(await reconcileLabels(db, { now })).toBe(0);

    expect((await queued()).map((j) => j.data)).toEqual([
      { orderId: order.id, requestedById: qa.userId },
    ]);
  });

  it("skips fresh labels, unknown ones and settled ones", async () => {
    await requested(2);
    expect(await reconcileLabels(db, { now })).toBe(0); // fresh
    const [first, second] = await labelRows();
    await db.shippingLabel.updateMany({ data: { createdAt: old } });
    await db.shippingLabel.update({
      where: { id: first?.id },
      data: { error: "errors.qa.purchaseUnknown" },
    });
    await db.shippingLabel.update({
      where: { id: second?.id },
      data: { status: "PURCHASE_FAILED" },
    });
    expect(await reconcileLabels(db, { now })).toBe(0);
  });

  it("queues the job for a bought label whose PDF never reached storage, once it is stale", async () => {
    const { order, qa } = await requested(1);
    await db.shippingLabel.updateMany({
      data: { status: "ACTIVE", storageKey: null, purchasedAt: old },
    });
    expect(await reconcileLabels(db, { now })).toBe(1);
    expect((await queued()).map((j) => j.data)).toEqual([
      { orderId: order.id, requestedById: qa.userId },
    ]);

    await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
    await db.shippingLabel.updateMany({ data: { purchasedAt: now } });
    expect(await reconcileLabels(db, { now })).toBe(0); // fresh: the job may still be running
    await db.shippingLabel.updateMany({ data: { purchasedAt: old, storageKey: "labels/x.pdf" } });
    expect(await reconcileLabels(db, { now })).toBe(0); // stored: nothing to do
  });
});

describe("QA queue labelState", () => {
  const stateOf = async (orderId: string) => {
    const actor = await createActor(db, ["QA"]);
    const page = await listQueue(db, actor, { stage: "QA" });
    return page.rows.find((r) => r.id === orderId)?.labelState;
  };

  it("shows none, purchasing, failed and unknown", async () => {
    const { order } = await requested(2);
    expect(await stateOf(order.id)).toBe("purchasing");
    const [first, second] = await labelRows();
    await db.shippingLabel.update({ where: { id: first?.id }, data: { status: "ACTIVE" } });
    await db.shippingLabel.update({
      where: { id: second?.id },
      data: { status: "PURCHASE_FAILED" },
    });
    expect(await stateOf(order.id)).toBe("failed");
    await db.shippingLabel.delete({ where: { id: second?.id } });
    expect(await stateOf(order.id)).toBe("none");
    await db.shippingLabel.update({
      where: { id: first?.id },
      data: { status: "PURCHASING", error: "errors.qa.purchaseUnknown" },
    });
    expect(await stateOf(order.id)).toBe("unknown");
  });
});
