import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { StoreError } from "../adapters/woocommerce/errors";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { withSyncLock } from "./lock";
import { type SyncOrdersOptions, syncOrders } from "./orders";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let store: FakeStoreAdapter;
beforeEach(async () => {
  await resetDb(db);
  store = new FakeStoreAdapter();
});

/** A run that wasn't refused by the lock (every test here expects it to get the lock). */
async function run(options: SyncOrdersOptions) {
  const result = await syncOrders(db, store, options);
  if (result.status === "alreadyRunning") throw new Error("unexpected alreadyRunning");
  return result;
}

const poll = (now?: Date) => run({ type: "ORDERS_POLL", now });
const HOUR = 60 * 60 * 1000;
const later = (ms: number) => new Date(store.now().getTime() + ms);

/**
 * `store` with one method held open: it calls through at once (so the copy it returns is from now),
 * then waits for `release()` before answering. `reached` resolves once the call was made.
 */
function held(target: FakeStoreAdapter, method: "getOrder" | "getProducts") {
  let reachedNow!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedNow = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = new Proxy(target, {
    get(t, key) {
      if (key === method) {
        return async (arg: never) => {
          const answer = await (t[method] as (a: never) => Promise<unknown>)(arg);
          reachedNow();
          await gate;
          return answer;
        };
      }
      const value = Reflect.get(t, key);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
  return { store: wrapped, reached, release };
}

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
      { fromStatus: null, toStatus: "PENDING", actorId: null, reason: "sync.reason.imported" },
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

    if (result.status === "alreadyRunning") throw new Error("unexpected alreadyRunning");
    expect(result.status).toBe("FAILED");
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: result.runId } })).toMatchObject({
      type: "ORDERS_POLL",
      status: "FAILED",
      error: "errors.sync.notConfigured",
    });
  });
});

describe("syncOrders: later polls (SC 2, SC 3 retry)", () => {
  it("asks for orders modified since the last finished poll started, minus 10 minutes", async () => {
    const first = later(HOUR);
    await poll(first);
    store.calls.length = 0;

    await poll(later(2 * HOUR));

    const listed = store.calls.filter((c) => c.method === "listOrders").map((c) => c.args[0]);
    expect(listed).toEqual([
      { modifiedAfter: new Date(first.getTime() - 10 * 60 * 1000), page: 1 },
    ]);
  });

  it("starts over from every processing order while no poll has finished", async () => {
    store.failNext("getUnits", new StoreError("unreachable"));
    await poll(later(HOUR));
    store.calls.length = 0;

    await poll(later(2 * HOUR));

    expect(store.calls.find((c) => c.method === "listOrders")?.args[0]).toEqual({
      status: "processing",
      page: 1,
    });
  });

  it("imports a new order created after the last poll, and nothing twice", async () => {
    store.addOrder();
    await poll(store.now());
    const next = store.addOrder();

    const result = await poll(store.now());

    expect(result).toMatchObject({ status: "SUCCEEDED", imported: 1, failed: 0 });
    expect(await db.order.count()).toBe(2);
    expect(await db.order.count({ where: { wooOrderId: next.id } })).toBe(1);
  });

  it("running the poll twice leaves one order and one set of lines", async () => {
    store.addOrder({ lines: [{}, {}] });

    await poll(store.now());
    const second = await poll(store.now());

    expect(second).toMatchObject({ imported: 0, skipped: 1 });
    expect(await db.order.count()).toBe(1);
    expect(await db.orderItem.count()).toBe(2);
    expect(await db.orderStageEvent.count()).toBe(1);
  });

  it("leaves a known order alone when the store hasn't modified it since", async () => {
    const woo = store.addOrder();
    await poll(store.now());
    const before = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });

    await poll(store.now());

    const after = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("leaves an anonymized order anonymized, with no external-change flag, when the store edits it", async () => {
    const woo = store.addOrder();
    await poll(store.now());
    const known = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    await db.order.update({
      where: { id: known.id },
      data: { customerName: "", customerEmail: null, piiRedactedAt: new Date() },
    });
    store.editOrder(woo.id, { customer_note: "Back door", status: "completed" });

    const polled = await poll(later(HOUR));
    const single = await run({ type: "ORDERS_WEBHOOK", orderIds: [woo.id], now: later(HOUR) });

    expect(polled).toMatchObject({ updated: 0, skipped: 1 });
    expect(single).toMatchObject({ updated: 0, skipped: 1 });
    const after = await db.order.findUniqueOrThrow({ where: { id: known.id } });
    expect(after).toMatchObject({
      customerName: "",
      customerEmail: null,
      customerNote: null,
      externalChangeDetectedAt: null,
      wooStatus: known.wooStatus,
    });
  });

  it("catches an edit made in the same second as the version it last imported", async () => {
    // WooCommerce's modified time has one-second resolution: equal times can still differ in content.
    const woo = store.addOrder();
    await poll(store.now());
    const sameSecond = (woo.raw as { date_modified_gmt: string }).date_modified_gmt;
    store.editOrder(woo.id, {
      customer_note: "Leave at the back door",
      date_modified_gmt: sameSecond,
    });

    const result = await poll(store.now());

    expect(result).toMatchObject({ updated: 1 });
    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    expect(order.customerNote).toBe("Leave at the back door");
    // And the same version again is still skipped.
    expect(await poll(store.now())).toMatchObject({ updated: 0, skipped: 1 });
  });

  it("never lets an older copy from the same second overwrite a newer one fetched after it", async () => {
    const woo = store.addOrder();
    await poll(store.now());
    const sameSecond = (woo.raw as { date_modified_gmt: string }).date_modified_gmt;
    store.editOrder(woo.id, { customer_note: "First", date_modified_gmt: sameSecond });

    // A slow webhook job: it fetches the "First" copy now and hands it over only later.
    const slow = held(store, "getOrder");
    const late = syncOrders(db, slow.store, {
      type: "ORDERS_WEBHOOK",
      orderIds: [woo.id],
      now: store.now(),
    });
    await slow.reached;
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Meanwhile the store changes again within the same second, and a faster job imports that.
    store.editOrder(woo.id, { customer_note: "Second", date_modified_gmt: sameSecond });
    await run({ type: "ORDERS_WEBHOOK", orderIds: [woo.id], now: store.now() });
    slow.release();

    expect(await late).toMatchObject({ updated: 0, skipped: 1 });
    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    expect(order.customerNote).toBe("Second");
  });

  it("a newer copy that loses the race to create the order is still applied", async () => {
    const woo = store.addOrder();
    // Both jobs find the order unknown, then wait while fetching its products.
    const older = held(store, "getProducts");
    const olderRun = syncOrders(db, older.store, {
      type: "ORDERS_WEBHOOK",
      orderIds: [woo.id],
      now: store.now(),
    });
    await older.reached;
    store.editOrder(woo.id, { customer_note: "Newer" });
    const newer = held(store, "getProducts");
    const newerRun = syncOrders(db, newer.store, {
      type: "ORDERS_WEBHOOK",
      orderIds: [woo.id],
      now: store.now(),
    });
    await newer.reached;

    older.release();
    expect(await olderRun).toMatchObject({ imported: 1 });
    newer.release();
    expect(await newerRun).toMatchObject({ imported: 0, updated: 1 });

    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    expect(order.customerNote).toBe("Newer");
    expect(await db.orderItem.count()).toBe(1);
  });

  it("records the store's latest modified time and payload on a known order", async () => {
    const woo = store.addOrder();
    await poll(store.now());
    const edited = store.editOrder(woo.id, { meta_data: [{ id: 3, key: "_note", value: "x" }] });

    const result = await poll(store.now());

    expect(result).toMatchObject({ updated: 1 });
    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    expect(order).toMatchObject({ wooModifiedAt: edited.dateModifiedGmt, version: 1 });
    expect(order.rawPayload).toMatchObject({ meta_data: [{ key: "_note" }] });
  });

  it("retries the ids that failed in the last poll, even outside its window", async () => {
    const woo = store.addOrder();
    store.failNext("getProducts", new StoreError("unreachable"));
    const first = await poll(later(HOUR));
    expect(first.failed).toBe(1);
    store.calls.length = 0;

    const second = await poll(later(2 * HOUR));

    expect(store.calls.filter((c) => c.method === "listOrders").map((c) => c.args[0])).toEqual([
      { modifiedAfter: expect.any(Date), page: 1 },
      { include: [woo.id], page: 1 },
    ]);
    expect(second).toMatchObject({ status: "SUCCEEDED", imported: 1 });
    expect(await db.order.count({ where: { wooOrderId: woo.id } })).toBe(1);
  });
});

describe("syncOrders: single orders and the run lock (SC 2, SC 8)", () => {
  it("imports just the given orders, fetched from the store", async () => {
    store.addOrder();
    const wanted = store.addOrder();

    const result = await run({ type: "ORDERS_WEBHOOK", orderIds: [wanted.id, 999_999] });

    expect(result).toMatchObject({ status: "SUCCEEDED", imported: 1, failed: 0 });
    expect(await db.order.findMany({ select: { wooOrderId: true } })).toEqual([
      { wooOrderId: wanted.id },
    ]);
    expect(await db.syncRun.findFirstOrThrow()).toMatchObject({ type: "ORDERS_WEBHOOK" });
    expect(store.calls.some((c) => c.method === "listOrders")).toBe(false);
  });

  it("a poll and a single-order import at the same time leave one order and one line set", async () => {
    const woo = store.addOrder({ lines: [{}, {}] });

    const results = await Promise.all([
      poll(store.now()),
      run({ type: "ORDERS_WEBHOOK", orderIds: [woo.id] }),
    ]);

    expect(results.map((r) => r.failed)).toEqual([0, 0]);
    expect(results.reduce((sum, r) => sum + r.imported, 0)).toBe(1);
    expect(await db.order.count()).toBe(1);
    expect(await db.orderItem.count()).toBe(2);
    expect(await db.orderStageEvent.count()).toBe(1);
  });

  it("returns alreadyRunning and writes nothing while another poll holds the lock", async () => {
    store.addOrder();
    const other = testDb();
    let result: unknown;
    try {
      await withSyncLock(other, "orders", async () => {
        result = await syncOrders(db, store, { type: "ORDERS_POLL" });
      });
    } finally {
      await other.$disconnect();
    }

    expect(result).toEqual({ status: "alreadyRunning" });
    expect(await db.syncRun.count()).toBe(0);
    expect(await db.order.count()).toBe(0);
  });

  it("single-order imports don't wait for the poll lock", async () => {
    const woo = store.addOrder();
    const other = testDb();
    try {
      await withSyncLock(other, "orders", async () => {
        await run({ type: "ORDERS_WEBHOOK", orderIds: [woo.id] });
      });
    } finally {
      await other.$disconnect();
    }

    expect(await db.order.count()).toBe(1);
  });
});
