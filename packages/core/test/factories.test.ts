import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "./db";
import { createOrder } from "./factories";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

describe("createOrder factory", () => {
  it("builds a pending order with one physical line by default", async () => {
    const { order, items, packages } = await createOrder(db);
    expect(order).toMatchObject({ status: "PENDING", version: 1, claimedById: null });
    expect(items).toHaveLength(1);
    expect(packages).toEqual([]);
    const product = await db.product.findUniqueOrThrow({
      where: { id: items[0]?.productId ?? "" },
    });
    expect(product.physical).toBe(true);
  });

  it("builds lines, voids, packages, rates and labels in any status", async () => {
    const qa = await createActor(db, ["QA"]);
    const { order, items, packages } = await createOrder(db, {
      status: "READY",
      claimedById: qa.userId,
      lines: [
        { sku: "TEE-M", quantity: 3, pickStatus: "PICKED", voids: [{ quantity: 1 }] },
        { sku: "RUSH", name: "Rush Order", quantity: 1, physical: false },
      ],
      packages: [
        {
          items: [{ line: 0, quantity: 2, verified: true }],
          rates: [{ selected: true }, { selected: false }],
          label: "ACTIVE",
        },
      ],
    });

    expect(order.status).toBe("READY");
    expect(items.map((i) => i.pickedQuantity)).toEqual([3, 0]);
    const rush = await db.product.findUniqueOrThrow({ where: { id: items[1]?.productId ?? "" } });
    expect(rush.physical).toBe(false);
    expect(await db.itemVoid.count({ where: { orderItemId: items[0]?.id } })).toBe(1);

    const [pkg] = packages;
    expect(pkg?.boxId).not.toBeNull();
    expect(Number(pkg?.weightOz)).toBeGreaterThan(0);
    const pkgItems = await db.packageItem.findMany({ where: { packageId: pkg?.id } });
    expect(pkgItems).toMatchObject([{ quantity: 2, orderItemId: items[0]?.id }]);
    expect(pkgItems[0]?.qaVerifiedAt).not.toBeNull();
    expect(await db.shippingRate.count({ where: { packageId: pkg?.id, selected: true } })).toBe(1);
    expect(await db.shippingLabel.findMany({ where: { packageId: pkg?.id } })).toMatchObject([
      { status: "ACTIVE" },
    ]);
  });

  it("gives every order a unique Woo id and number", async () => {
    const a = await createOrder(db);
    const b = await createOrder(db);
    expect(a.order.wooOrderId).not.toBe(b.order.wooOrderId);
    expect(a.order.number).not.toBe(b.order.number);
  });

  it("settings carry a claim expiry, 30 minutes by default", async () => {
    const settings = await db.settings.create({ data: {} });
    expect(settings.claimExpiryMinutes).toBe(30);
  });
});
