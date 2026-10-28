import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { demoRate, verifiedQaOrder } from "../../test/qa-fixtures";
import { AppError } from "../errors";
import { updateSettings } from "../settings/service";
import { completeQaWithLabels } from "./complete";
import { labelCostCents, needsCostConfirmation } from "./cost-guard";

describe("needsCostConfirmation", () => {
  const on = { ratio: 2, freeCents: 1500 };

  it("asks when the labels cost more than ratio × what the customer paid", () => {
    expect(needsCostConfirmation(2001, 1000, on)).toBe(true);
    expect(needsCostConfirmation(2000, 1000, on)).toBe(false);
    expect(needsCostConfirmation(500, 1000, on)).toBe(false);
  });

  it("uses the free-shipping amount when the customer paid nothing", () => {
    expect(needsCostConfirmation(1501, 0, on)).toBe(true);
    expect(needsCostConfirmation(1500, 0, on)).toBe(false);
  });

  it("each check is off when its setting is empty", () => {
    expect(needsCostConfirmation(99_999, 1000, { ratio: null, freeCents: 1500 })).toBe(false);
    expect(needsCostConfirmation(99_999, 0, { ratio: 2, freeCents: null })).toBe(false);
    expect(needsCostConfirmation(99_999, 0, { ratio: null, freeCents: null })).toBe(false);
  });

  it("doesn't use the ratio for free-shipping orders or the amount for paid ones", () => {
    expect(needsCostConfirmation(99_999, 0, { ratio: 2, freeCents: null })).toBe(false);
    expect(needsCostConfirmation(99_999, 1000, { ratio: null, freeCents: 1500 })).toBe(false);
  });
});

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.settings.updateMany({
    data: { labelCostConfirmRatio: 2, labelCostConfirmFreeCents: 1500 },
  });
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

const labels = () => db.shippingLabel.findMany();
const jobs = () =>
  db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pgboss.job WHERE name = 'labels.purchase'`);

async function ready(charged: number, count = 2) {
  const built = await verifiedQaOrder(db, count); // $4.50 per package
  await db.order.update({ where: { id: built.order.id }, data: { shippingChargedCents: charged } });
  const request = (confirmCost?: boolean, expectedVersion = built.order.version) =>
    completeQaWithLabels(db, built.qa, { orderId: built.order.id, expectedVersion, confirmCost });
  return { ...built, request };
}

describe("Complete QA cost guard", () => {
  it("asks first, writing nothing, and returns both amounts", async () => {
    const { request, order } = await ready(300); // labels $9.00 > 2 × $3.00
    const error = await request().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.qa.costConfirmRequired",
      params: { labelCostCents: 900, chargedCents: 300 },
    });
    expect(await labels()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(
      order.version,
    );
  });

  it("buys with confirmCost and the audit records the confirmation and amounts", async () => {
    const { request, qa } = await ready(300);
    await request(true);
    expect(await labels()).toHaveLength(2);
    expect(await jobs()).toHaveLength(1);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: "labels.purchaseRequested" },
    });
    expect(audit.actorId).toBe(qa.userId);
    expect(audit.after).toMatchObject({
      costConfirmed: true,
      labelCostCents: 900,
      chargedCents: 300,
    });
  });

  it("doesn't ask when the cost is within the ratio, and records costConfirmed false", async () => {
    const { request } = await ready(450); // 900 = 2 × 450
    await request();
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: "labels.purchaseRequested" },
    });
    expect(audit.after).toMatchObject({ costConfirmed: false, labelCostCents: 900 });
  });

  it("uses the free-shipping amount when the customer paid nothing", async () => {
    const { request } = await ready(0, 4); // $18.00 > $15.00
    await expect(request()).rejects.toMatchObject({ messageKey: "errors.qa.costConfirmRequired" });
    await request(true);
    expect(await labels()).toHaveLength(4);
  });

  it("never asks when both checks are off", async () => {
    const { request } = await ready(300);
    await db.settings.upsert({
      where: { id: 1 },
      create: { id: 1, labelCostConfirmRatio: null, labelCostConfirmFreeCents: null },
      update: { labelCostConfirmRatio: null, labelCostConfirmFreeCents: null },
    });
    await request();
    expect(await labels()).toHaveLength(2);
  });

  it("asks again on a retry when the new rate costs more", async () => {
    const { request, packages, rates } = await ready(600, 1); // $4.50 ≤ 2 × $6.00
    await db.shippingRate.update({ where: { id: rates[0]?.id }, data: { amountCents: 1300 } });
    await expect(request()).rejects.toMatchObject({ messageKey: "errors.qa.costConfirmRequired" });
    await request(true);
    expect(await labels()).toHaveLength(1);
    // the label fails; QA picks a dearer rate and retries
    await db.shippingLabel.updateMany({
      data: { status: "PURCHASE_FAILED", error: "errors.shipping.notOffered" },
    });
    await db.shippingRate.updateMany({ data: { selected: false } });
    await demoRate(db, packages[0]?.id as string, { amountCents: 5000, selected: true });
    const version = (await db.order.findFirstOrThrow()).version;
    await expect(request(undefined, version)).rejects.toMatchObject({
      messageKey: "errors.qa.costConfirmRequired",
      params: { labelCostCents: 5000, chargedCents: 600 },
    });
  });

  it("counts a bought label at its cost, and doesn't ask when only moving the order", async () => {
    const { request, packages } = await ready(300, 2);
    const first = packages[0];
    await db.shippingLabel.create({
      data: {
        packageId: first?.id,
        status: "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: "bought",
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        currency: "USD",
        storageKey: "labels/x.pdf",
        costCents: 700,
      },
    });
    // 700 (bought) + 450 (to buy), not 450 + 450
    await expect(request()).rejects.toMatchObject({
      params: { labelCostCents: 1150, chargedCents: 300 },
    });
    expect(await labels()).toHaveLength(1);
  });

  it("moves an order whose labels are all bought without asking", async () => {
    const { request, packages } = await ready(100, 1);
    await db.shippingLabel.create({
      data: {
        packageId: packages[0]?.id,
        status: "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: "bought",
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        currency: "USD",
        storageKey: "labels/x.pdf",
        costCents: 9000,
      },
    });
    expect((await request()).status).toBe("READY");
  });
});

describe("cost thresholds in settings", () => {
  it("only settings.manage changes them, audited, and null turns a check off", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const qa = await createActor(db, ["QA"]);
    await expect(updateSettings(db, qa, { labelCostConfirmRatio: 3 })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const updated = await updateSettings(db, admin, {
      labelCostConfirmRatio: 3.5,
      labelCostConfirmFreeCents: null,
    });
    expect(updated).toMatchObject({ labelCostConfirmRatio: 3.5, labelCostConfirmFreeCents: null });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityType: "Settings", action: "update" },
    });
    expect(audit.after).toMatchObject({
      labelCostConfirmRatio: 3.5,
      labelCostConfirmFreeCents: null,
    });
  });

  it("labelCostCents sums selected rates", async () => {
    const { order } = await verifiedQaOrder(db, 3);
    expect(await labelCostCents(db, order.id)).toBe(1350);
  });
});
