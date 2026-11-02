import { UpdateProductCustomsInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { syncProducts } from "../sync/products";
import { customsProducts, updateProductCustoms } from "./customs";

// The customs editor (SPEC-shipping "Customs", FR-SHIP-13).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const parse = (input: object) =>
  UpdateProductCustomsInput.safeParse({ productId: crypto.randomUUID(), ...input });

describe("customs validation", () => {
  it("stores an HS code without dots, 6 to 10 digits", () => {
    expect(parse({ hsCode: "3401.11" }).data?.hsCode).toBe("340111");
    expect(parse({ hsCode: " 3401.11.0010 " }).data?.hsCode).toBe("3401110010");
    for (const bad of ["34011", "34011100101", "3401-11", "abc123", ""]) {
      expect(parse({ hsCode: bad }).success, bad).toBe(false);
    }
  });

  it("takes an ISO alpha-2 country of origin, upper-cased", () => {
    expect(parse({ countryOfOrigin: "us" }).data?.countryOfOrigin).toBe("US");
    for (const bad of ["USA", "U", "1A", ""]) {
      expect(parse({ countryOfOrigin: bad }).success, bad).toBe(false);
    }
  });

  it("limits the description to 100 characters", () => {
    expect(parse({ customsDescription: "x".repeat(100) }).success).toBe(true);
    expect(parse({ customsDescription: "x".repeat(101) }).success).toBe(false);
    expect(parse({ customsDescription: "   " }).success).toBe(false);
  });

  it("clears a field with null", () => {
    expect(parse({ hsCode: null }).data?.hsCode).toBeNull();
  });
});

describe("updateProductCustoms", () => {
  async function product() {
    const { items } = await createOrder(db);
    return db.product.findUniqueOrThrow({ where: { id: items[0]?.productId as string } });
  }

  it("changes only the fields given and audits product.customs with before and after", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const p = await product();
    await db.product.update({ where: { id: p.id }, data: { countryOfOrigin: "US" } });

    const result = await updateProductCustoms(db, admin, {
      productId: p.id,
      hsCode: "340111",
      customsDescription: "Bar soap",
    });

    expect(result).toMatchObject({
      id: p.id,
      hsCode: "340111",
      countryOfOrigin: "US",
      customsDescription: "Bar soap",
      missing: false,
    });
    const event = await db.auditEvent.findFirstOrThrow({ where: { entityId: p.id } });
    expect(event).toMatchObject({
      entityType: "Product",
      action: "customs",
      actorId: admin.userId,
      before: { hsCode: null, customsDescription: null },
      after: { hsCode: "340111", customsDescription: "Bar soap" },
    });
  });

  it("writes no audit event when nothing changes", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const p = await product();
    await updateProductCustoms(db, admin, { productId: p.id, hsCode: "340111" });
    await updateProductCustoms(db, admin, { productId: p.id, hsCode: "340111" });
    expect(await db.auditEvent.count({ where: { action: "customs" } })).toBe(1);
  });

  it("clears a field with null", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const p = await product();
    await updateProductCustoms(db, admin, { productId: p.id, hsCode: "340111" });
    const result = await updateProductCustoms(db, admin, { productId: p.id, hsCode: null });
    expect(result.hsCode).toBeNull();
    expect(result.missing).toBe(true);
  });

  it("answers not found for an unknown product", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      updateProductCustoms(db, admin, { productId: crypto.randomUUID(), hsCode: "340111" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("is allowed for product.manage and forbidden for every other role", async () => {
    const p = await product();
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      updateProductCustoms(db, admin, { productId: p.id, hsCode: "340111" }),
    ).resolves.toBeDefined();
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      const actor = await createActor(db, [role]);
      await expect(
        updateProductCustoms(db, actor, { productId: p.id, hsCode: "340112" }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await expect(customsProducts(db, actor, { filter: "all" })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    }
    expect((await db.product.findUniqueOrThrow({ where: { id: p.id } })).hsCode).toBe("340111");
  });

  it("survives a product sync", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const store = new FakeStoreAdapter();
    const soap = store.addProduct({ sku: "SOAP" });
    await syncProducts(db, store, { now: store.now() });
    const row = await db.product.findUniqueOrThrow({ where: { wooProductId: soap.id } });
    await updateProductCustoms(db, admin, {
      productId: row.id,
      hsCode: "340111",
      countryOfOrigin: "US",
      customsDescription: "Bar soap",
    });

    store.editProduct(soap.id, { name: "Soap v2", weight: "3" });
    await syncProducts(db, store, { now: store.now() });

    const after = await db.product.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({
      name: "Soap v2",
      hsCode: "340111",
      countryOfOrigin: "US",
      customsDescription: "Bar soap",
    });
  });
});

describe("customsProducts", () => {
  it("lists physical products by name, filters to missing data, and flags the missing", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { items } = await createOrder(db, {
      lines: [{ name: "A soap" }, { name: "B balm" }, { name: "Rush", physical: false }],
    });
    const [a, b] = items;
    await db.product.update({
      where: { id: a?.productId as string },
      data: { hsCode: "340111", countryOfOrigin: "US" },
    });

    const all = await customsProducts(db, admin, { filter: "all" });
    expect(all.items.map((i) => [i.name, i.missing])).toEqual([
      ["A soap", false],
      ["B balm", true],
    ]);

    const missing = await customsProducts(db, admin, { filter: "missing" });
    expect(missing.items.map((i) => i.id)).toEqual([b?.productId]);
  });

  it("filters to products on an open international order, by ship-to over the Woo address", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await db.settings.create({
      data: { id: 1, shipFromAddress: { country: "US" } },
    });
    const intl = await createOrder(db, { lines: [{ name: "Canada soap" }] });
    await db.order.update({
      where: { id: intl.order.id },
      data: { shippingAddress: { country: "CA" } },
    });
    const overridden = await createOrder(db, { lines: [{ name: "Moved to US" }] });
    await db.order.update({
      where: { id: overridden.order.id },
      data: { shippingAddress: { country: "CA" }, shipTo: { country: "US" } },
    });
    const done = await createOrder(db, { status: "COMPLETED", lines: [{ name: "Old CA" }] });
    await db.order.update({
      where: { id: done.order.id },
      data: { shippingAddress: { country: "CA" } },
    });
    await createOrder(db, { lines: [{ name: "Domestic" }] });

    const page = await customsProducts(db, admin, { filter: "international" });
    expect(page.items.map((i) => i.name)).toEqual(["Canada soap"]);
    expect(page.items[0]?.onInternationalOrder).toBe(true);
  });

  it("pages with a cursor", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createOrder(db, { lines: Array.from({ length: 5 }, (_, i) => ({ name: `P${i}` })) });
    const first = await customsProducts(db, admin, { filter: "all" }, { pageSize: 2 });
    expect(first.items).toHaveLength(2);
    const second = await customsProducts(
      db,
      admin,
      { filter: "all", cursor: first.nextCursor as string },
      { pageSize: 2 },
    );
    expect(second.items.map((i) => i.name)).toEqual(["P2", "P3"]);
    const third = await customsProducts(
      db,
      admin,
      { filter: "all", cursor: second.nextCursor as string },
      { pageSize: 2 },
    );
    expect(third.items.map((i) => i.name)).toEqual(["P4"]);
    expect(third.nextCursor).toBeNull();
  });
});
