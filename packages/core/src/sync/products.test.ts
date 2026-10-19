import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { StoreError } from "../adapters/woocommerce/errors";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { withSyncLock } from "./lock";
import { syncProducts } from "./products";

// The catalog sync (SPEC-store-sync "Products", SC 9, FR-SYNC-12).

const db: Db = testDb();
const other: Db = testDb();
afterAll(() => Promise.all([db.$disconnect(), other.$disconnect()]));

let store: FakeStoreAdapter;
beforeEach(async () => {
  await resetDb(db);
  store = new FakeStoreAdapter();
});

async function sync() {
  const result = await syncProducts(db, store, { now: store.now() });
  if (result.status === "alreadyRunning") throw new Error("unexpected alreadyRunning");
  return result;
}

const variable = () =>
  store.addProduct({
    type: "variable",
    name: "Body Lotion",
    variations: [
      { name: "8oz", sku: "LOT-8", weight: "0.5" },
      { name: "16oz", sku: "LOT-16", weight: "1" },
    ],
  });

describe("syncProducts", () => {
  it("writes every product over every page, with variations of variable ones", async () => {
    for (let i = 0; i < 149; i++) store.addProduct();
    const lotion = variable();

    const result = await sync();

    expect(result).toMatchObject({ status: "SUCCEEDED", processed: 150, failed: 0 });
    expect(await db.product.count()).toBe(150);
    const variations = await db.productVariation.findMany({ orderBy: { sku: "asc" } });
    expect(variations.map((v) => [v.sku, v.weightOz?.toNumber()])).toEqual([
      ["LOT-16", 16],
      ["LOT-8", 8],
    ]);
    expect(store.calls.filter((c) => c.method === "listVariations")).toEqual([
      { method: "listVariations", args: [lotion.id] },
    ]);
    expect(await db.syncRun.findFirstOrThrow()).toMatchObject({
      type: "PRODUCTS",
      status: "SUCCEEDED",
      recordsProcessed: 150,
      recordsFailed: 0,
    });
  });

  it("refreshes weight, dimensions, stock, bin and physical, and leaves warehouse fields alone", async () => {
    const soap = store.addProduct({ sku: "SOAP" });
    await sync();
    const warehouse = {
      hsCode: "3401.11",
      countryOfOrigin: "US",
      customsDescription: "Bar soap",
      lumexiaItemId: "LX-42",
      barcode: "0123456789012",
    };
    await db.product.update({ where: { wooProductId: soap.id }, data: warehouse });
    store.editProduct(soap.id, {
      weight: "2",
      dimensions: { length: "5", width: "4", height: "3" },
      stock_quantity: 7,
      virtual: true,
      meta_data: [{ id: 1, key: "_bin_location", value: "B-12" }],
    });

    await sync();

    const row = await db.product.findUniqueOrThrow({ where: { wooProductId: soap.id } });
    expect(row).toMatchObject({
      stockQuantity: 7,
      binLocation: "B-12",
      physical: false,
      ...warehouse,
    });
    expect([row.weightOz, row.lengthIn, row.widthIn, row.heightIn].map(Number)).toEqual([
      32, 5, 4, 3,
    ]);
  });

  it("takes a barcode the store sends", async () => {
    const soap = store.addProduct();
    await sync();
    await db.product.update({ where: { wooProductId: soap.id }, data: { barcode: "OLD" } });
    store.editProduct(soap.id, { global_unique_id: "4006381333931" });

    await sync();

    expect((await db.product.findUniqueOrThrow({ where: { wooProductId: soap.id } })).barcode).toBe(
      "4006381333931",
    );
  });

  it("leaves a product the store deleted as it is", async () => {
    const gone = store.addProduct({ name: "Discontinued" });
    await sync();
    const before = await db.product.findUniqueOrThrow({ where: { wooProductId: gone.id } });
    store.removeProduct(gone.id);

    await sync();

    expect(await db.product.findUniqueOrThrow({ where: { wooProductId: gone.id } })).toEqual(
      before,
    );
  });

  it("records a product that fails, writes the rest, and ends PARTIAL", async () => {
    store.addProduct({ sku: "A" });
    const lotion = variable();
    store.failNext("listVariations", new StoreError("badResponse", "broken variation"));

    const result = await sync();

    expect(result).toMatchObject({ status: "PARTIAL", processed: 1, failed: 1 });
    expect(await db.product.findMany({ select: { sku: true } })).toEqual([{ sku: "A" }]);
    expect(await db.syncRunError.findFirstOrThrow()).toMatchObject({
      externalId: String(lotion.id),
      error: "errors.sync.badResponse: broken variation",
    });
  });

  it("fails the run when the store refuses the keys", async () => {
    store.addProduct();
    store.failNext("listProducts", new StoreError("unauthorized"));

    expect(await sync()).toMatchObject({ status: "FAILED" });
    expect(await db.syncRun.findFirstOrThrow()).toMatchObject({
      type: "PRODUCTS",
      status: "FAILED",
      error: "errors.sync.unauthorized",
    });
  });

  it("fails the run with notConfigured when there's no store", async () => {
    const result = await syncProducts(db, null);

    expect(result).toMatchObject({ status: "FAILED" });
    expect((await db.syncRun.findFirstOrThrow()).error).toBe("errors.sync.notConfigured");
  });

  it("reports alreadyRunning and writes nothing while another catalog sync holds the lock", async () => {
    store.addProduct();
    let inner: unknown;
    await withSyncLock(other, "products", async () => {
      inner = await syncProducts(db, store, { now: store.now() });
    });

    expect(inner).toEqual({ status: "alreadyRunning" });
    expect(await db.syncRun.count()).toBe(0);
    expect(await db.product.count()).toBe(0);
  });
});
