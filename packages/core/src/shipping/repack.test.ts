import type { Db, LabelStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { fakeProvider, verifiedQaOrder } from "../../test/qa-fixtures";
import { ShippingError } from "../adapters/shipping/errors";
import { repackOrders } from "./repack";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/** A Ready order with `count` packages, each holding a label in `status` and a selected rate. */
async function ready(count = 2, status: LabelStatus = "ACTIVE") {
  const built = await verifiedQaOrder(db, count);
  await db.order.update({
    where: { id: built.order.id },
    data: { status: "READY", claimedById: null },
  });
  const labels = [];
  for (const [i, p] of built.packages.entries()) {
    await db.package.update({ where: { id: p.id }, data: { ratesStatus: "READY" } });
    labels.push(
      await db.shippingLabel.create({
        data: {
          packageId: p.id,
          status,
          provider: "SHIPSTATION",
          idempotencyKey: `k-${i}`,
          providerLabelId: `se-label-${i}`,
          carrierCode: "demo_ground",
          serviceCode: "demo_ground",
          currency: "USD",
        },
      }),
    );
  }
  const provider = fakeProvider();
  let n = 0;
  const run = (
    actor: Awaited<ReturnType<typeof createActor>>,
    extra: { orderIds?: string[]; issueId?: string; reason?: string } = {},
  ) =>
    repackOrders(
      db,
      actor,
      {
        orderIds: extra.orderIds ?? [built.order.id],
        reason: extra.reason ?? "Wrong scent",
        issueId: extra.issueId,
        idempotencyKey: `repack-${++n}-${Math.random()}`,
      },
      { providers: [provider] },
    );
  return { ...built, labels, provider, run };
}

describe("repackOrders", () => {
  it("voids the labels, clears rates and verification, keeps packages and moves to Packing", async () => {
    const { order, labels, packages, run } = await ready();
    const shipper = await createActor(db, ["SHIPPER"]);
    const issue = await db.qualityIssue.create({
      data: {
        orderId: order.id,
        packageId: packages[1]?.id,
        type: "WRONG_ITEM",
        severity: "MAJOR",
        description: "Wrong scent",
        discoveredStage: "SHIPPING",
      },
    });

    const result = await run(shipper, { issueId: issue.id });

    expect(result.orders).toEqual([
      { orderId: order.id, repacked: true, error: null, blocked: [] },
    ]);
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PACKING");
    expect(await db.shippingLabel.count({ where: { status: "VOIDED" } })).toBe(labels.length);
    expect(await db.shippingRate.count()).toBe(0);
    expect(await db.package.count({ where: { orderId: order.id, ratesStatus: "NONE" } })).toBe(2);
    expect(await db.package.count({ where: { orderId: order.id } })).toBe(2);
    const items = await db.packageItem.findMany({ where: { package: { orderId: order.id } } });
    expect(items.every((i) => i.qaVerifiedQuantity === 0 && i.qaVerifiedAt === null)).toBe(true);
    expect(
      await db.orderStageEvent.count({ where: { orderId: order.id, reason: "Wrong scent" } }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({ where: { action: "order.repack", entityId: order.id } }),
    ).toBe(1);
    expect(await db.qualityIssue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
      labelId: labels[1]?.id,
      triggeredRepack: true,
    });
  });

  it("leaves a rejected void in Ready with the package and reason, deleting nothing", async () => {
    const { order, labels, provider, run } = await ready();
    vi.spyOn(provider, "voidLabel")
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValue({ approved: false, message: "Too late" });
    const admin = await createActor(db, ["ADMIN"]);

    const result = await run(admin);

    expect(result.orders[0]).toMatchObject({
      repacked: false,
      blocked: [
        {
          labelId: labels[1]?.id,
          packageNumber: 2,
          status: "VOID_REJECTED",
          error: "errors.qa.voidRejected",
        },
      ],
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("READY");
    expect(await db.shippingRate.count()).toBe(2);
    expect(await db.shippingLabel.count()).toBe(2);
  });

  it("reports a provider that doesn't answer and goes through on the retry", async () => {
    const { order, provider, run } = await ready(1);
    const spy = vi
      .spyOn(provider, "voidLabel")
      .mockRejectedValueOnce(new ShippingError("unavailable", "voidLabel 503"));
    const qa = await createActor(db, ["QA"]);

    const first = await run(qa);
    expect(first.orders[0]?.blocked).toMatchObject([
      { status: "VOID_REQUESTED", error: "errors.shipping.unavailable" },
    ]);

    spy.mockResolvedValue({ approved: true });
    expect((await run(qa)).orders[0]?.repacked).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PACKING");
  });

  it("refuses an order that isn't Ready and replays an idempotency key", async () => {
    const { order, run } = await ready(1);
    await db.order.update({ where: { id: order.id }, data: { status: "COMPLETED" } });
    const admin = await createActor(db, ["ADMIN"]);
    const result = await run(admin);
    expect(result.orders[0]).toMatchObject({
      repacked: false,
      error: "errors.workflow.illegalTransition",
    });
    expect(await db.shippingLabel.count({ where: { status: "ACTIVE" } })).toBe(1);

    const input = { orderIds: [order.id], reason: "x", idempotencyKey: "same-key" };
    const first = await repackOrders(db, admin, input, { providers: [] });
    expect(await repackOrders(db, admin, input, { providers: [] })).toEqual(first);
  });

  it.each(["PACKER", "PICKER"] as const)("forbids a %s", async (role) => {
    const { labels, run } = await ready(1);
    const actor = await createActor(db, [role]);
    await expect(run(actor)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(
      (await db.shippingLabel.findUniqueOrThrow({ where: { id: labels[0]?.id } })).status,
    ).toBe("ACTIVE");
  });

  it("allows Shipper, QA and Admin", async () => {
    for (const role of ["SHIPPER", "QA", "ADMIN"] as const) {
      await resetDb(db);
      const { order, run } = await ready(1);
      expect((await run(await createActor(db, [role]))).orders[0]?.repacked).toBe(true);
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "PACKING",
      );
    }
  });
});
