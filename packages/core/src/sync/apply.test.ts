import type { Db, Order, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import type { ExternalChangeSummary } from "./apply";
import { syncOrders } from "./orders";

// The change table (SPEC-store-sync "Change detection", SC 5), through the real import: import an
// order, change it in the store, poll again.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let store: FakeStoreAdapter;
beforeEach(async () => {
  await resetDb(db);
  store = new FakeStoreAdapter();
});

async function poll() {
  const result = await syncOrders(db, store, { type: "ORDERS_POLL", now: store.now() });
  if (result.status === "alreadyRunning") throw new Error("unexpected alreadyRunning");
  expect(result.failed).toBe(0);
  return result;
}

/** An imported order with two lines (ids 1 and 2), optionally moved along by the floor. */
async function imported(floor: Prisma.OrderUncheckedUpdateInput = {}) {
  const woo = store.addOrder({ lines: [{ id: 1, quantity: 3 }, { id: 2 }] });
  await poll();
  const order = await db.order.update({ where: { wooOrderId: woo.id }, data: floor });
  return { woo, order };
}

const reload = (id: string) =>
  db.order.findUniqueOrThrow({
    where: { id },
    include: {
      items: { orderBy: { wooLineItemId: "asc" } },
      stageEvents: { orderBy: { at: "asc" } },
    },
  });

const summaryOf = (order: Order) => order.externalChangeSummary as ExternalChangeSummary | null;

const newStreet = {
  first_name: "Test",
  last_name: "Customer",
  company: "",
  address_1: "9 New Rd",
  address_2: "",
  city: "Austin",
  state: "TX",
  postcode: "78702",
  country: "US",
  phone: "",
};

describe("store cancels an order", () => {
  it("untouched: cancels it as the system, with no flag", async () => {
    const { woo, order } = await imported();
    store.cancelOrder(woo.id);

    await poll();

    const after = await reload(order.id);
    expect(after).toMatchObject({
      status: "CANCELLED",
      wooStatus: "cancelled",
      externalChangeDetectedAt: null,
    });
    expect(after.stageEvents.at(-1)).toMatchObject({
      fromStatus: "PENDING",
      toStatus: "CANCELLED",
      actorId: null,
      reason: "sync.reason.cancelledInStore",
    });
  });

  it("untouched: a full refund cancels it too", async () => {
    const { woo, order } = await imported();
    store.refundOrder(woo.id);

    await poll();

    expect((await reload(order.id)).status).toBe("CANCELLED");
  });

  it("in progress: holds it as cancelled in store and flags it", async () => {
    const { woo, order } = await imported({ status: "PICKING" });
    store.cancelOrder(woo.id);

    await poll();

    const after = await reload(order.id);
    expect(after).toMatchObject({
      status: "ON_HOLD",
      heldFromStatus: "PICKING",
      holdReason: "sync.reason.cancelledInStore",
    });
    expect(after.externalChangeDetectedAt).not.toBeNull();
    expect(summaryOf(after)?.diff.status).toEqual({ from: "processing", to: "cancelled" });
    expect(after.stageEvents.at(-1)).toMatchObject({ toStatus: "ON_HOLD", actorId: null });
    expect(after.version).toBeGreaterThan(order.version);
  });

  it("already on hold: stays on hold, flagged, with no new stage event", async () => {
    const { woo, order } = await imported({
      status: "ON_HOLD",
      heldFromStatus: "PACKING",
      holdReason: "Waiting on stock",
    });
    store.cancelOrder(woo.id);

    await poll();

    const after = await reload(order.id);
    expect(after).toMatchObject({ status: "ON_HOLD", holdReason: "Waiting on stock" });
    expect(after.stageEvents).toHaveLength(1);
    expect(summaryOf(after)?.diff.status?.to).toBe("cancelled");
  });

  it("a pending order someone has claimed counts as started", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { woo, order } = await imported({ claimedById: picker.userId, claimedAt: new Date() });
    store.cancelOrder(woo.id);

    await poll();

    expect(await reload(order.id)).toMatchObject({ status: "ON_HOLD", heldFromStatus: "PENDING" });
  });

  it("a pending order with a note counts as started", async () => {
    const { woo, order } = await imported();
    await db.note.create({ data: { orderId: order.id, content: "Call the customer" } });
    store.cancelOrder(woo.id);

    await poll();

    expect((await reload(order.id)).status).toBe("ON_HOLD");
  });
});

describe("store edits an order", () => {
  it("untouched: applies the address in place and audits it as the system", async () => {
    const { woo, order } = await imported();
    store.editOrder(woo.id, { shipping: newStreet });

    await poll();

    const after = await reload(order.id);
    expect(after.shippingAddress).toMatchObject({ address1: "9 New Rd", postalCode: "78702" });
    expect(after).toMatchObject({ externalChangeDetectedAt: null, status: "PENDING" });
    expect(after.version).toBe(order.version + 1);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityId: order.id, action: "order.externalChange.applied" },
    });
    expect(audit.actorId).toBeNull();
    expect(audit.after).toMatchObject({ shippingAddress: { to: { address1: "9 New Rd" } } });
  });

  it("untouched: applies added, removed and re-quantified lines, and recomputes priority", async () => {
    await db.priorityRule.create({
      data: {
        name: "Rush",
        condition: { type: "lineItem", match: "sku", value: "RUSH" },
        priority: 2,
        position: 0,
      },
    });
    const rush = store.addProduct({ name: "Rush Order", sku: "RUSH", virtual: true });
    const { woo, order } = await imported();
    store.editOrder(woo.id, {
      lines: [
        { id: 1, quantity: 5 },
        { id: 3, product: rush.id },
      ],
    });

    await poll();

    const after = await reload(order.id);
    expect(after.items.map((i) => [i.wooLineItemId, i.quantity])).toEqual([
      [1, 5],
      [3, 1],
    ]);
    const added = after.items[1];
    expect(added?.productId).not.toBeNull();
    expect(
      await db.product.findUniqueOrThrow({ where: { id: added?.productId ?? "" } }),
    ).toMatchObject({ sku: "RUSH", physical: false });
    expect(after.priority).toBe(2);
    // Lines 5 × $10 and 1 × $10, plus $5 shipping.
    expect(after.totalCents).toBe(6500);
  });

  it("in progress: flags an exact diff and leaves the order as it was", async () => {
    const { woo, order } = await imported({ status: "PACKING" });
    const edited = store.editOrder(woo.id, {
      shipping: newStreet,
      lines: [{ id: 1, quantity: 2 }],
    });

    await poll();

    const after = await reload(order.id);
    expect(after.shippingAddress).toEqual(order.shippingAddress);
    expect(after.items.map((i) => i.quantity)).toEqual([3, 1]);
    expect(after).toMatchObject({
      status: "PACKING",
      wooModifiedAt: edited.dateModifiedGmt,
      version: order.version + 1,
    });
    expect(after.externalChangeDetectedAt).not.toBeNull();
    const summary = summaryOf(after);
    expect(summary?.diff).toEqual({
      shippingAddress: {
        from: order.shippingAddress,
        to: expect.objectContaining({ address1: "9 New Rd" }),
      },
      lines: {
        added: [],
        removed: [expect.objectContaining({ wooLineItemId: 2 })],
        quantity: [expect.objectContaining({ wooLineItemId: 1, from: 3, to: 2 })],
      },
    });
    expect(summary?.incoming).toMatchObject({ wooOrderId: woo.id, number: woo.number });
    expect(summary?.incoming).not.toHaveProperty("rawPayload");
  });

  it("a second change while flagged replaces the diff, still against the stored order", async () => {
    const { woo, order } = await imported({ status: "PICKING" });
    store.cancelOrder(woo.id);
    await poll();
    store.editOrder(woo.id, { customer_note: "Never mind" });

    await poll();

    const diff = summaryOf(await reload(order.id))?.diff;
    expect(diff).toMatchObject({
      status: { from: "processing", to: "cancelled" },
      customerNote: { from: null, to: "Never mind" },
    });
  });

  it("clears the flag when the store goes back to what Woolrus has", async () => {
    const { woo, order } = await imported({ status: "PICKING" });
    store.editOrder(woo.id, { customer_note: "Gift wrap" });
    await poll();
    expect((await reload(order.id)).externalChangeDetectedAt).not.toBeNull();
    store.editOrder(woo.id, { customer_note: "" });

    await poll();

    const after = await reload(order.id);
    expect(after).toMatchObject({ externalChangeDetectedAt: null, externalChangeSummary: null });
  });

  it("only updates the store's modified time and payload when untracked fields change", async () => {
    const { woo, order } = await imported({ status: "PICKING" });
    const edited = store.editOrder(woo.id, {
      meta_data: [{ id: 5, key: "_tracking", value: "x" }],
    });

    await poll();

    const after = await reload(order.id);
    expect(after).toMatchObject({
      version: order.version,
      externalChangeDetectedAt: null,
      wooModifiedAt: edited.dateModifiedGmt,
    });
    expect(after.rawPayload).toMatchObject({ meta_data: [{ key: "_tracking" }] });
  });
});

describe("other store changes", () => {
  it("a partial refund on an untouched order is flagged, not applied", async () => {
    const { woo, order } = await imported();
    store.refundOrder(woo.id, "8.00");

    await poll();

    const after = await reload(order.id);
    expect(after.status).toBe("PENDING");
    expect(summaryOf(after)?.diff).toMatchObject({ refunds: { from: 0, to: 800 } });
    expect(summaryOf(after)?.diff.status).toBeUndefined();
  });

  it("any other status change on an untouched order is flagged", async () => {
    const { woo, order } = await imported();
    store.editOrder(woo.id, { status: "on-hold" });

    await poll();

    const after = await reload(order.id);
    expect(after).toMatchObject({ status: "PENDING", wooStatus: "on-hold" });
    expect(summaryOf(after)?.diff.status).toEqual({ from: "processing", to: "on-hold" });
  });

  it.each([
    ["COMPLETED", "cancelled"],
    ["CANCELLED", "completed"],
  ] as const)(
    "a %s order is only flagged, with a status that isn't its own (%s)",
    async (status, to) => {
      const { woo, order } = await imported({ status });
      store.editOrder(woo.id, { status: to, shipping: newStreet });

      await poll();

      const after = await reload(order.id);
      expect(after.status).toBe(status);
      expect(after.shippingAddress).toEqual(order.shippingAddress);
      expect(after.stageEvents).toHaveLength(1);
      expect(summaryOf(after)?.diff).toMatchObject({
        status: { to },
        shippingAddress: { to: { address1: "9 New Rd" } },
      });
    },
  );

  // Once `shipping` pushes Completed, or `exceptions` refunds a cancelled order, the store is only
  // catching up with Woolrus: nothing to review.
  it.each([
    ["COMPLETED", (id: number) => store.editOrder(id, { status: "completed" })],
    ["CANCELLED", (id: number) => store.cancelOrder(id)],
    ["CANCELLED", (id: number) => store.refundOrder(id)],
  ] as const)(
    "a %s order isn't flagged when the store reaches the same end",
    async (status, edit) => {
      const { woo, order } = await imported({ status });
      const changed = edit(woo.id);

      await poll();

      const after = await reload(order.id);
      expect(after).toMatchObject({
        status,
        externalChangeDetectedAt: null,
        wooStatus: changed.status,
        version: order.version,
      });
    },
  );

  it("a completed order whose address changes in the store is still flagged", async () => {
    const { woo, order } = await imported({ status: "COMPLETED" });
    store.editOrder(woo.id, { status: "completed", shipping: newStreet });

    await poll();

    const diff = summaryOf(await reload(order.id))?.diff;
    expect(diff?.status).toBeUndefined();
    expect(diff?.shippingAddress).toMatchObject({ to: { address1: "9 New Rd" } });
  });
});
