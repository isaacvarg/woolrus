import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { syncProducts } from "../sync/products";
import { linkBarcode } from "./link-barcode";
import { scan } from "./scan";

// Linking an unknown scanned code (SPEC-picking "Code matching: linking a barcode", decision 2).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const admin = () => createActor(db, ["ADMIN"]);

/** A Picking order claimed by `claimer` (an admin by default, who can also link). */
async function picking(lines: LineSpec[], claimer?: Awaited<ReturnType<typeof admin>>) {
  const actor = claimer ?? (await admin());
  const built = await createOrder(db, {
    status: "PICKING",
    version: 2,
    claimedById: actor.userId,
    claimedAt: new Date(),
    lines,
  });
  return { actor, ...built, item: built.items[0] as (typeof built.items)[number] };
}

const scanId = () => crypto.randomUUID();

describe("linkBarcode", () => {
  it("puts the code on the line's product when it has no variation", async () => {
    const { actor, item } = await picking([{ name: "Lavender soap", sku: "LAV-8" }]);

    const result = await linkBarcode(db, actor, { orderItemId: item.id, code: " 0042 " });

    expect(result).toEqual({ barcode: "0042", linkedTo: "product", name: "Lavender soap" });
    const product = await db.product.findUniqueOrThrow({ where: { id: item.productId as string } });
    expect(product.barcode).toBe("0042");
  });

  it("puts the code on the line's variation when it has one, leaving the product alone", async () => {
    const { actor, item } = await picking([
      { name: "Lotion 8 oz", barcode: "PARENT", variation: { sku: "LOT-8" } },
    ]);

    const result = await linkBarcode(db, actor, { orderItemId: item.id, code: "0043" });

    expect(result).toMatchObject({ barcode: "0043", linkedTo: "variation" });
    const variation = await db.productVariation.findUniqueOrThrow({
      where: { id: item.variationId as string },
    });
    expect(variation.barcode).toBe("0043");
    const product = await db.product.findUniqueOrThrow({ where: { id: item.productId as string } });
    expect(product.barcode).toBe("PARENT");
  });

  it("is audited as product.linkBarcode with before and after", async () => {
    const { actor, item } = await picking([{ barcode: "OLD" }]);

    await linkBarcode(db, actor, { orderItemId: item.id, code: "NEW" });

    expect(await db.auditEvent.findMany()).toMatchObject([
      {
        entityType: "Product",
        entityId: item.productId,
        action: "product.linkBarcode",
        actorId: actor.userId,
        before: { barcode: "OLD" },
        after: { barcode: "NEW" },
      },
    ]);
  });

  it("makes the next scan of the code match, on this order and on others", async () => {
    const { actor, order, item } = await picking([{ sku: "LAV-8", quantity: 2 }]);
    await expect(
      scan(db, actor, { orderId: order.id, code: "0044", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanUnknown" });

    await linkBarcode(db, actor, { orderItemId: item.id, code: "0044" });
    const result = await scan(db, actor, { orderId: order.id, code: "0044", scanId: scanId() });

    expect(result.line).toMatchObject({ id: item.id, pickedQuantity: 1 });
    // Another order of the same product now refuses it by name, not as unknown.
    const other = await picking([{ sku: "OTHER" }], actor);
    await expect(
      scan(db, actor, { orderId: other.order.id, code: "0044", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanNotOnOrder" });
  });

  it("keeps the linked code through a store sync that sends none", async () => {
    const store = new FakeStoreAdapter();
    const soap = store.addProduct({ sku: "SOAP" });
    await syncProducts(db, store, { now: store.now() });
    const product = await db.product.findUniqueOrThrow({ where: { wooProductId: soap.id } });
    const { actor, item } = await picking([{ noProduct: true }]);
    await db.orderItem.update({ where: { id: item.id }, data: { productId: product.id } });

    await linkBarcode(db, actor, { orderItemId: item.id, code: "0045" });
    await syncProducts(db, store, { now: new Date(store.now().getTime() + 60_000) });

    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).barcode).toBe(
      "0045",
    );
  });

  describe("refuses, changing nothing,", () => {
    it.each([
      ["another product's barcode", { name: "Rose soap", barcode: "taken" }],
      ["another product's SKU", { name: "Rose soap", sku: "TAKEN" }],
      ["another variation's barcode", { name: "Rose soap", variation: { barcode: "TAKEN" } }],
      ["another variation's SKU", { name: "Rose soap", variation: { sku: "taken " } }],
    ] as const)("a code that is %s, naming it", async (_, owner) => {
      const { actor, item } = await picking([{ sku: "LAV-8" }]);
      await createOrder(db, { lines: [owner] });

      await expect(
        linkBarcode(db, actor, { orderItemId: item.id, code: "Taken" }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.codeInUse",
        params: { name: "Rose soap" },
      });
      const product = await db.product.findUniqueOrThrow({
        where: { id: item.productId as string },
      });
      expect(product.barcode).toBeNull();
      expect(await db.auditEvent.count()).toBe(0);
    });

    it("a line with no product to link to", async () => {
      const { actor, item } = await picking([{ noProduct: true }]);

      await expect(
        linkBarcode(db, actor, { orderItemId: item.id, code: "0046" }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.picking.noProductToLink" });
    });

    it("a line that doesn't exist", async () => {
      await expect(
        linkBarcode(db, await admin(), {
          orderItemId: "00000000-0000-7000-8000-000000000000",
          code: "0047",
        }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    });

    it("for a picker, who can't manage products", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { item } = await picking([{ sku: "LAV-8" }], picker);

      await expect(
        linkBarcode(db, picker, { orderItemId: item.id, code: "0048" }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      expect(await db.auditEvent.count()).toBe(0);
    });
  });

  it("allows the code the line's own product already uses as its SKU", async () => {
    const { actor, item } = await picking([{ variation: { sku: "LOT-8" }, sku: "LOT" }]);

    await expect(
      linkBarcode(db, actor, { orderItemId: item.id, code: "lot" }),
    ).resolves.toMatchObject({ linkedTo: "variation" });
  });
});

describe("scan of an unknown code", () => {
  it("offers linking to callers who can manage products", async () => {
    const { actor, order } = await picking([{ sku: "LAV-8" }]);

    await expect(
      scan(db, actor, { orderId: order.id, code: "000", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanUnknown", canLink: true });
  });

  it("doesn't offer it to a picker", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await picking([{ sku: "LAV-8" }], picker);

    const error = await scan(db, picker, {
      orderId: order.id,
      code: "000",
      scanId: scanId(),
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ messageKey: "errors.picking.scanUnknown" });
    expect((error as { canLink?: boolean }).canLink).toBeFalsy();
  });
});
