import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { StoreError } from "../adapters/woocommerce/errors";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { syncOrders } from "./orders";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let store: FakeStoreAdapter;
beforeEach(async () => {
  await resetDb(db);
  store = new FakeStoreAdapter();
});

const poll = () => syncOrders(db, store, { type: "ORDERS_POLL" });

describe("syncOrders: first import (SC 1)", () => {
  it("imports all 230 processing orders over 3 pages, and skips other statuses", async () => {
    for (let i = 0; i < 230; i++) store.addOrder();
    store.addOrder({ status: "on-hold" });
    store.addOrder({ status: "completed" });

    const result = await poll();

    expect(result).toMatchObject({ status: "SUCCEEDED", imported: 230, failed: 0 });
    expect(await db.order.count()).toBe(230);
    expect(await db.order.count({ where: { status: "PENDING" } })).toBe(230);
    expect(
      await db.orderStageEvent.count({ where: { fromStatus: null, toStatus: "PENDING" } }),
    ).toBe(230);
    const listed = store.calls.filter((c) => c.method === "listOrders").map((c) => c.args[0]);
    expect(listed).toEqual([1, 2, 3].map((page) => ({ status: "processing", page })));
  }, 60_000);

  it("stores every mapped order field, its lines and their products", async () => {
    store.units = { weight: "lbs", dimension: "cm" };
    const soap = store.addProduct({
      name: "Lavender Bar Soap",
      sku: "SOAP-LAV",
      price: "8.00",
      weight: "0.25",
      dimensions: { length: "10", width: "5", height: "2.54" },
      stock_quantity: 12,
      images: [{ id: 1, src: "https://store.test/soap.jpg" }],
      meta_data: [{ id: 1, key: "_bin_location", value: "A-01" }],
    });
    const rush = store.addProduct({
      name: "Rush Order",
      sku: "RUSH",
      price: "5.00",
      virtual: true,
    });
    const tee = store.addProduct({
      type: "variable",
      name: "Tee",
      sku: "TEE",
      variations: [
        {
          name: "Tee - Medium",
          sku: "TEE-M",
          weight: "0.5",
          attributes: [{ id: 0, name: "Size", option: "Medium" }],
        },
      ],
    });
    const [variation] = await store.listVariations(tee.id);
    const variationId = variation?.id;
    const woo = store.addOrder({
      number: "A-100",
      customer_note: "Leave at the door",
      shipping: {
        first_name: "Ana",
        last_name: "Lopez",
        company: "",
        address_1: "742 Evergreen Ter",
        address_2: "",
        city: "Springfield",
        state: "OR",
        postcode: "97477",
        country: "US",
        phone: "",
      },
      shipping_lines: [
        { method_title: "Express", total: "12.50" },
        { method_title: "Insurance", total: "1.00" },
      ],
      lines: [
        { product: soap.id, quantity: 3 },
        { product: rush.id },
        { product: tee.id, variation: variationId, quantity: 2 },
        { product: 0, name: "Gone", sku: "OLD", price: "1.00" },
      ],
    });

    await poll();

    const order = await db.order.findUniqueOrThrow({
      where: { wooOrderId: woo.id },
      include: {
        items: { include: { product: true, variation: true }, orderBy: { wooLineItemId: "asc" } },
        stageEvents: true,
      },
    });
    expect(order).toMatchObject({
      number: "A-100",
      wooStatus: "processing",
      currency: "USD",
      customerName: "Ana Lopez",
      customerEmail: "customer@example.test",
      customerNote: "Leave at the door",
      paymentMethod: "Credit card",
      shippingMethod: "Express, Insurance",
      shippingChargedCents: 1350,
      totalCents: 2400 + 500 + 2000 + 100 + 1350,
      orderedAt: woo.dateCreatedGmt,
      wooModifiedAt: woo.dateModifiedGmt,
      status: "PENDING",
      version: 1,
      claimedById: null,
    });
    expect(order.shippingAddress).toMatchObject({ name: "Ana Lopez", city: "Springfield" });
    expect(order.rawPayload).toMatchObject({ id: woo.id, number: "A-100" });
    expect(order.stageEvents).toMatchObject([
      { fromStatus: null, toStatus: "PENDING", actorId: null, reason: "imported" },
    ]);

    const [soapLine, rushLine, teeLine, goneLine] = order.items;
    expect(soapLine).toMatchObject({ name: "Lavender Bar Soap", quantity: 3, unitPriceCents: 800 });
    expect(soapLine?.product).toMatchObject({
      wooProductId: soap.id,
      sku: "SOAP-LAV",
      imageUrl: "https://store.test/soap.jpg",
      priceCents: 800,
      stockQuantity: 12,
      binLocation: "A-01",
      physical: true,
    });
    expect(Number(soapLine?.product?.weightOz)).toBe(4);
    expect(Number(soapLine?.product?.heightIn)).toBe(1);
    expect(rushLine?.product?.physical).toBe(false);
    expect(teeLine?.product?.wooProductId).toBe(tee.id);
    expect(teeLine?.variation).toMatchObject({ wooVariationId: variationId, sku: "TEE-M" });
    expect(Number(teeLine?.variation?.weightOz)).toBe(8);
    expect(goneLine).toMatchObject({ productId: null, variationId: null, sku: "OLD" });

    const audit = await db.auditEvent.findMany({ where: { entityId: order.id } });
    expect(audit).toMatchObject([{ action: "order.import", actorId: null }]);
  });

  it("links bundled lines to their bundle line", async () => {
    const woo = store.addOrder({
      lines: [
        { id: 501 },
        { id: 502, meta_data: [{ id: 9, key: "_bundled_by", value: "501" }], bundled_by: 501 },
      ],
    });

    await poll();

    const items = await db.orderItem.findMany({
      where: { order: { wooOrderId: woo.id } },
      orderBy: { wooLineItemId: "asc" },
    });
    expect(items[1]?.bundleParentId).toBe(items[0]?.id);
    expect(items[0]?.bundleParentId).toBeNull();
  });

  it("computes priority from the enabled rules", async () => {
    await db.priorityRule.create({
      data: {
        name: "Express",
        condition: { type: "shippingMethod", contains: "Express" },
        priority: 1,
        position: 0,
      },
    });
    const express = store.addOrder({
      shipping_lines: [{ method_title: "Express", total: "9.00" }],
    });
    const plain = store.addOrder();

    await poll();

    const priorities = await db.order.findMany({ select: { wooOrderId: true, priority: true } });
    expect(priorities).toEqual(
      expect.arrayContaining([
        { wooOrderId: express.id, priority: 1 },
        { wooOrderId: plain.id, priority: 0 },
      ]),
    );
  });

  it("reuses a product fetched within 24 hours instead of asking the store again", async () => {
    const product = store.addProduct();
    store.addOrder({ lines: [{ product: product.id }] });
    store.addOrder({ lines: [{ product: product.id }] });

    await poll();

    expect(store.calls.filter((c) => c.method === "getProducts")).toHaveLength(1);
    expect(await db.product.count()).toBe(1);
  });
});

describe("syncOrders: one order failing (SC 3)", () => {
  it("rolls back only that order, records the error and ends PARTIAL", async () => {
    const good = store.addOrder();
    const bad = store.addOrder({
      total: "15.00",
      shipping_lines: [{ method_title: "Flat rate", total: "five" }],
    });

    const result = await poll();

    expect(result).toMatchObject({ status: "PARTIAL", imported: 1, failed: 1 });
    expect(await db.order.findMany({ select: { wooOrderId: true } })).toEqual([
      { wooOrderId: good.id },
    ]);
    const run = await db.syncRun.findUniqueOrThrow({
      where: { id: result.runId },
      include: { errors: true },
    });
    expect(run).toMatchObject({ status: "PARTIAL", recordsProcessed: 1, recordsFailed: 1 });
    expect(run.errors).toMatchObject([{ externalId: String(bad.id) }]);
    expect(run.errors[0]?.error).toMatch(/^errors\.sync\.badResponse/);
  });

  it("writes nothing for an order whose product fetch fails", async () => {
    const product = store.addProduct();
    const woo = store.addOrder({ lines: [{ product: product.id }] });
    store.failNext("getProducts", new StoreError("unreachable", "GET /products"));

    const result = await poll();

    expect(result).toMatchObject({ status: "PARTIAL", imported: 0, failed: 1 });
    expect(await db.order.count()).toBe(0);
    expect(await db.orderItem.count()).toBe(0);
    expect(await db.product.count()).toBe(0);
    const errors = await db.syncRunError.findMany();
    expect(errors).toMatchObject([
      { externalId: String(woo.id), error: "errors.sync.unreachable: GET /products" },
    ]);
  });

  it("rolls back an order whose write fails part way", async () => {
    // Two orders claiming line 7: whichever is imported second fails on its second line.
    store.addOrder({ lines: [{ id: 8 }, { id: 7 }] });
    store.addOrder({ lines: [{ id: 7 }, { id: 9 }] });

    const result = await poll();

    expect(result).toMatchObject({ status: "PARTIAL", imported: 1, failed: 1 });
    const [failed] = await db.syncRunError.findMany();
    expect(await db.order.count({ where: { wooOrderId: Number(failed?.externalId) } })).toBe(0);
    expect(await db.order.count()).toBe(1);
    expect(await db.orderItem.count()).toBe(2);
    expect(failed?.error).toMatch(/^errors\.sync\.importFailed: /);
  });
});

describe("syncOrders: the run log (SC 4)", () => {
  it("writes one finished run with its type, counts and times", async () => {
    store.addOrder();
    store.addOrder();

    const result = await poll();

    const runs = await db.syncRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.runId,
      type: "ORDERS_POLL",
      status: "SUCCEEDED",
      recordsProcessed: 2,
      recordsFailed: 0,
      error: null,
    });
    expect(runs[0]?.finishedAt?.getTime()).toBeGreaterThanOrEqual(
      runs[0]?.startedAt.getTime() ?? 0,
    );
  });

  it("fails the whole run on wrong credentials", async () => {
    store.addOrder();
    store.failNext("getUnits", new StoreError("unauthorized", "GET /settings", 401));

    const result = await poll();

    expect(result).toMatchObject({ status: "FAILED", imported: 0 });
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: result.runId } })).toMatchObject({
      status: "FAILED",
      error: "errors.sync.unauthorized",
    });
    expect(await db.order.count()).toBe(0);
  });

  it("fails the run when the order list can't be fetched", async () => {
    store.addOrder();
    store.failNext("listOrders", new StoreError("unreachable"));

    const result = await poll();

    expect(result.status).toBe("FAILED");
    const run = await db.syncRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.error).toBe("errors.sync.unreachable");
  });

  it("fails with notConfigured when there is no WooCommerce config", async () => {
    const result = await syncOrders(db, null, { type: "ORDERS_POLL" });

    expect(result.status).toBe("FAILED");
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: result.runId } })).toMatchObject({
      type: "ORDERS_POLL",
      status: "FAILED",
      error: "errors.sync.notConfigured",
    });
  });
});
