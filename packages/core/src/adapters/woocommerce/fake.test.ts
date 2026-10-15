import { describe, expect, it } from "vitest";
import { mapOrder } from "../../sync/mapping";
import { StoreError } from "./errors";
import { FakeStoreAdapter } from "./fake";

describe("FakeStoreAdapter", () => {
  it("pages 230 orders as 3 pages of at most 100, newest first", async () => {
    const store = new FakeStoreAdapter();
    for (let i = 0; i < 230; i++) store.addOrder();

    const pages = await Promise.all([1, 2, 3, 4].map((page) => store.listOrders({ page })));
    expect(pages.map((p) => p.orders.length)).toEqual([100, 100, 30, 0]);
    expect(pages.map((p) => p.totalPages)).toEqual([3, 3, 3, 3]);

    const ids = pages.flatMap((p) => p.orders.map((o) => o.id));
    expect(new Set(ids).size).toBe(230);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("reports one page when there are no orders, like the HTTP adapter", async () => {
    expect(await new FakeStoreAdapter().listOrders({ page: 1 })).toEqual({
      orders: [],
      totalPages: 1,
    });
  });

  it("filters by status, modifiedAfter and include", async () => {
    const store = new FakeStoreAdapter();
    const a = store.addOrder();
    const b = store.addOrder({ status: "on-hold" });
    const since = store.now();
    const c = store.addOrder();
    const ids = async (q: Parameters<FakeStoreAdapter["listOrders"]>[0]) =>
      (await store.listOrders(q)).orders.map((o) => o.id);

    expect(await ids({ page: 1, status: "processing" })).toEqual([c.id, a.id]);
    expect(await ids({ page: 1, modifiedAfter: since })).toEqual([c.id]);
    expect(await ids({ page: 1, include: [a.id, b.id, 999] })).toEqual([b.id, a.id]);
  });

  it("builds orders that parse and map, with lines priced from the store's products", async () => {
    const store = new FakeStoreAdapter();
    const soap = store.addProduct({ name: "Soap", sku: "SOAP", price: "8.00" });
    const order = store.addOrder({
      lines: [{ product: soap.id, quantity: 3 }],
      shipping_lines: [{ method_title: "Standard", total: "6.00" }],
    });

    const mapped = mapOrder(order);
    expect(mapped).toMatchObject({ wooStatus: "processing", totalCents: 3000 });
    expect(mapped.items).toEqual([
      expect.objectContaining({
        wooProductId: soap.id,
        name: "Soap",
        sku: "SOAP",
        quantity: 3,
        unitPriceCents: 800,
      }),
    ]);
    expect(await store.getOrder(order.id)).toEqual(order);
    expect(await store.getOrder(999_999)).toBeNull();
  });

  it("edits, cancels and refunds orders, bumping date_modified_gmt each time", async () => {
    const store = new FakeStoreAdapter();
    const order = store.addOrder({ lines: [{ quantity: 2, price: "10.00" }] });
    const [{ id: lineId } = { id: 0 }] = order.lineItems;

    const edited = store.editOrder(order.id, {
      customer_note: "Leave at the door",
      lines: [
        { id: lineId, quantity: 1 },
        { quantity: 4, price: "2.50" },
      ],
    });
    expect(edited.customerNote).toBe("Leave at the door");
    expect(edited.lineItems.map((l) => [l.id === lineId, l.quantity])).toEqual([
      [true, 1],
      [false, 4],
    ]);
    // Lines 10.00 + 10.00, plus the default 5.00 flat rate.
    expect(edited.total).toBe("25.00");
    expect(edited.dateModifiedGmt > order.dateModifiedGmt).toBe(true);

    const partial = store.refundOrder(order.id, "5.00");
    expect(partial).toMatchObject({ status: "processing", refunds: [{ total: "-5.00" }] });
    const full = store.refundOrder(order.id);
    expect(full.status).toBe("refunded");
    expect(full.refunds.map((r) => r.total)).toEqual(["-5.00", "-20.00"]);

    const other = store.addOrder();
    expect(store.cancelOrder(other.id).status).toBe("cancelled");
    expect(store.cancelOrder(other.id).dateModifiedGmt > other.dateModifiedGmt).toBe(true);
  });

  it("returns copies, so callers can't change the store by mutating a result", async () => {
    const store = new FakeStoreAdapter();
    const order = store.addOrder();
    (order.raw as { status: string }).status = "completed";
    order.lineItems.length = 0;
    expect(await store.getOrder(order.id)).toMatchObject({ status: "processing" });
    expect((await store.getOrder(order.id))?.lineItems).toHaveLength(1);
  });

  it("serves products by id and page, and variations per product", async () => {
    const store = new FakeStoreAdapter();
    const soap = store.addProduct({ name: "Soap", weight: "0.3" });
    const lotion = store.addProduct({
      type: "variable",
      name: "Lotion",
      variations: [
        { name: "8oz", attributes: [{ name: "Size", option: "8oz" }], price: "14.00" },
        { name: "16oz", attributes: [{ name: "Size", option: "16oz" }], price: "22.00" },
      ],
    });

    expect((await store.getProducts([soap.id, 999])).map((p) => p.name)).toEqual(["Soap"]);
    expect(await store.listProducts(1)).toMatchObject({ totalPages: 1 });
    expect((await store.listProducts(1)).products.map((p) => p.id)).toEqual([lotion.id, soap.id]);

    const variations = await store.listVariations(lotion.id);
    expect(variations.map((v) => [v.name, v.price])).toEqual([
      ["8oz", "14.00"],
      ["16oz", "22.00"],
    ]);
    expect(await store.listVariations(soap.id)).toEqual([]);

    const variation = variations[1]?.id;
    const line = store.addOrder({ lines: [{ product: lotion.id, variation }] }).lineItems[0];
    expect(line).toMatchObject({ productId: lotion.id, variationId: variation });
    expect(line).toMatchObject({ name: "Lotion - 16oz", price: "22" });
  });

  it("reports the configured units and records every call", async () => {
    const store = new FakeStoreAdapter({ units: { weight: "kg", dimension: "cm" } });
    await store.ping();
    expect(await store.getUnits()).toEqual({ weight: "kg", dimension: "cm" });
    await store.getProducts([1, 2]);
    expect(store.calls).toEqual([
      { method: "ping", args: [] },
      { method: "getUnits", args: [] },
      { method: "getProducts", args: [[1, 2]] },
    ]);
  });

  it("fails the next calls of a method with a given error", async () => {
    const store = new FakeStoreAdapter();
    store.failNext("listOrders", new StoreError("unauthorized"), 2);

    await expect(store.listOrders({ page: 1 })).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(store.listOrders({ page: 1 })).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(store.listOrders({ page: 1 })).resolves.toMatchObject({ orders: [] });
    await expect(store.ping()).resolves.toBeUndefined();
  });
});
