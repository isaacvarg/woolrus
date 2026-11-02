import type { Db, LabelStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { fakeProvider, verifiedQaOrder } from "../../test/qa-fixtures";
import { retryVoid, stuckLabels, writeOffLabel } from "./labels";
import { repackOrders } from "./repack";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/** A Ready order with one label stuck in `status`. */
async function stuck(status: LabelStatus = "VOID_REJECTED") {
  const built = await verifiedQaOrder(db, 1);
  await db.order.update({
    where: { id: built.order.id },
    data: { status: "READY", claimedById: null },
  });
  const pkg = built.packages[0];
  await db.package.update({ where: { id: pkg?.id }, data: { ratesStatus: "READY" } });
  const label = await db.shippingLabel.create({
    data: {
      packageId: pkg?.id,
      status,
      provider: "SHIPSTATION",
      idempotencyKey: "stuck-key",
      providerLabelId: "se-label-stuck",
      carrierCode: "demo_ground",
      serviceCode: "demo_ground",
      currency: "USD",
      voidReason: "Wrong scent",
      error: "errors.qa.voidRejected",
    },
  });
  const provider = fakeProvider();
  return { ...built, label, provider };
}

describe("retryVoid", () => {
  it("voids a rejected label once the provider approves, so the repack goes through", async () => {
    const { order, label, provider } = await stuck();
    vi.spyOn(provider, "voidLabel").mockResolvedValue({ approved: true });
    const shipper = await createActor(db, ["SHIPPER"]);

    const result = await retryVoid(db, shipper, { labelId: label.id }, { providers: [provider] });

    expect(result).toEqual({ orderId: order.id, status: "VOIDED" });
    const repacked = await repackOrders(
      db,
      shipper,
      { orderIds: [order.id], reason: "Wrong scent", idempotencyKey: "r1" },
      { providers: [provider] },
    );
    expect(repacked.orders[0]?.repacked).toBe(true);
  });

  it("keeps the label rejected when the provider declines again", async () => {
    const { label, provider } = await stuck();
    vi.spyOn(provider, "voidLabel").mockResolvedValue({ approved: false });
    const shipper = await createActor(db, ["SHIPPER"]);
    const result = await retryVoid(db, shipper, { labelId: label.id }, { providers: [provider] });
    expect(result.status).toBe("VOID_REJECTED");
  });

  it("refuses an active label and a Picker", async () => {
    const { label, provider } = await stuck("ACTIVE");
    const shipper = await createActor(db, ["SHIPPER"]);
    await expect(
      retryVoid(db, shipper, { labelId: label.id }, { providers: [provider] }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    const picker = await createActor(db, ["PICKER"]);
    await expect(
      retryVoid(db, picker, { labelId: label.id }, { providers: [provider] }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("writeOffLabel", () => {
  it.each(["VOID_REJECTED", "VOID_REQUESTED"] as const)(
    "writes off a %s label, audited with the reason, and the repack goes through",
    async (status) => {
      const { order, label, provider } = await stuck(status);
      const admin = await createActor(db, ["ADMIN"]);

      const result = await writeOffLabel(db, admin, { labelId: label.id, reason: "  Shipped  " });

      expect(result).toEqual({ orderId: order.id, status: "WRITTEN_OFF" });
      const after = await db.shippingLabel.findUniqueOrThrow({ where: { id: label.id } });
      expect(after.status).toBe("WRITTEN_OFF");
      expect(after.costCents).toBe(label.costCents);
      const audit = await db.auditEvent.findFirstOrThrow({
        where: { action: "label.writeOff", entityId: label.id },
      });
      expect(audit.after).toMatchObject({ status: "WRITTEN_OFF", reason: "Shipped" });
      const repacked = await repackOrders(
        db,
        admin,
        { orderIds: [order.id], reason: "Wrong scent", idempotencyKey: "r2" },
        { providers: [provider] },
      );
      expect(repacked.orders[0]?.repacked).toBe(true);
    },
  );

  it("forbids a Shipper and leaves the label alone", async () => {
    const { label } = await stuck();
    const shipper = await createActor(db, ["SHIPPER"]);
    await expect(
      writeOffLabel(db, shipper, { labelId: label.id, reason: "x" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect((await db.shippingLabel.findUniqueOrThrow({ where: { id: label.id } })).status).toBe(
      "VOID_REJECTED",
    );
  });

  it("refuses an active label and a blank reason", async () => {
    const active = await stuck("ACTIVE");
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      writeOffLabel(db, admin, { labelId: active.label.id, reason: "x" }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    await expect(
      writeOffLabel(db, admin, { labelId: active.label.id, reason: "  " }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});

describe("stuckLabels", () => {
  it("lists the labels waiting for a retry or write-off", async () => {
    const { order, label } = await stuck();
    const shipper = await createActor(db, ["SHIPPER"]);
    expect(await stuckLabels(db, shipper, { orderId: order.id })).toMatchObject({
      labels: [
        {
          id: label.id,
          packageNumber: 1,
          status: "VOID_REJECTED",
          error: "errors.qa.voidRejected",
        },
      ],
      canWriteOff: false,
    });
    const admin = await createActor(db, ["ADMIN"]);
    expect((await stuckLabels(db, admin, { orderId: order.id })).canWriteOff).toBe(true);
    const picker = await createActor(db, ["PICKER"]);
    await expect(stuckLabels(db, picker, { orderId: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});
