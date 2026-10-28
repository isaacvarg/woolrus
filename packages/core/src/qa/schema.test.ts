import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";

// The qa schema additions (SPEC-qa "Schema additions"): the hand-written range and positive checks.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

async function packageItem(quantity = 3) {
  const { packages } = await createOrder(db, {
    status: "QA",
    packages: [{ items: [{ line: 0, quantity }] }],
  });
  const pkg = packages[0];
  if (!pkg) throw new Error("no package");
  const row = await db.packageItem.findFirst({ where: { packageId: pkg.id } });
  if (!row) throw new Error("no package item");
  return row;
}

describe("PackageItem.qaVerifiedQuantity", () => {
  it("starts at zero and accepts 0 through the quantity", async () => {
    const row = await packageItem(3);
    expect(row.qaVerifiedQuantity).toBe(0);
    for (const n of [0, 2, 3]) {
      await expect(
        db.packageItem.update({ where: { id: row.id }, data: { qaVerifiedQuantity: n } }),
      ).resolves.toMatchObject({ qaVerifiedQuantity: n });
    }
  });

  it("refuses a negative count and one above the quantity", async () => {
    const row = await packageItem(3);
    for (const n of [-1, 4]) {
      await expect(
        db.packageItem.update({ where: { id: row.id }, data: { qaVerifiedQuantity: n } }),
      ).rejects.toThrow();
    }
  });
});

describe("Settings label cost thresholds", () => {
  it("defaults to 2.0x and $15, and allows both off", async () => {
    const s = await db.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    expect(Number(s.labelCostConfirmRatio)).toBe(2);
    expect(s.labelCostConfirmFreeCents).toBe(1500);
    await expect(
      db.settings.update({
        where: { id: 1 },
        data: { labelCostConfirmRatio: null, labelCostConfirmFreeCents: null },
      }),
    ).resolves.toMatchObject({ labelCostConfirmRatio: null, labelCostConfirmFreeCents: null });
  });

  it("refuses a zero or negative ratio and amount", async () => {
    await db.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    for (const data of [
      { labelCostConfirmRatio: 0 },
      { labelCostConfirmRatio: -1 },
      { labelCostConfirmFreeCents: 0 },
      { labelCostConfirmFreeCents: -5 },
    ]) {
      await expect(db.settings.update({ where: { id: 1 }, data })).rejects.toThrow();
    }
  });
});

describe("ShippingLabel purchase fields", () => {
  it("records the attempt, exact carrier and service, and quoted amount", async () => {
    const { packages } = await createOrder(db, { status: "QA", packages: [{}] });
    const pkg = packages[0];
    if (!pkg) throw new Error("no package");
    const carrier = await db.shippingCarrier.create({
      data: { provider: "SHIPSTATION", externalId: "se-1", code: "usps", name: "USPS" },
    });
    const service = await db.carrierService.create({
      data: {
        carrierId: carrier.id,
        code: "usps_ground_advantage",
        name: "GA",
        domestic: true,
        international: false,
      },
    });
    const label = await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: "PURCHASING",
        provider: "SHIPSTATION",
        idempotencyKey: crypto.randomUUID(),
        carrierCode: "usps",
        serviceCode: "usps_ground_advantage",
        currency: "USD",
        purchaseAttemptedAt: new Date(),
        carrierId: carrier.id,
        serviceId: service.id,
        quotedAmountCents: 812,
      },
    });
    expect(label).toMatchObject({
      carrierId: carrier.id,
      serviceId: service.id,
      quotedAmountCents: 812,
    });
    expect(label.purchaseAttemptedAt).toBeInstanceOf(Date);
  });
});
