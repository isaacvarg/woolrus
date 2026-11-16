import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { systemActor } from "../permissions";
import { updateSettings } from "../settings/service";
import { createBatch, getBatch } from "./batches";
import { getBatchSuggestions } from "./queries";

// SPEC-picking A1, success criteria 19 and 20: the suggestions read over real Pending orders.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
let age = 1000;
/** Each order is a minute newer than the last, so queue order is creation order. */
function pendingOrder(spec: Parameters<typeof createOrder>[1] = {}) {
  age -= 1;
  return createOrder(db, { orderedAt: minutesAgo(age), ...spec });
}

/** A product line to share: the first order's line, which later orders copy with `sameAs`. */
async function sharingOrders(count: number) {
  const first = await pendingOrder({ lines: [{ name: "Gallon X", quantity: 2 }] });
  const item = first.items[0] as NonNullable<(typeof first.items)[0]>;
  const rest = [];
  for (let i = 1; i < count; i++) {
    rest.push(await pendingOrder({ lines: [{ sameAs: item, quantity: 1 }, { name: `Own ${i}` }] }));
  }
  return [first, ...rest].map((b) => b.order);
}

describe("getBatchSuggestions", () => {
  it("groups Pending orders by the products they share", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [a, b, c] = await sharingOrders(3);
    await pendingOrder({ lines: [{ name: "Candle" }] });

    const result = await getBatchSuggestions(db, picker);

    expect(result.openBatch).toBeNull();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      orders: [a, b, c].map((o) => ({ id: o?.id, number: o?.number, version: o?.version })),
      units: 2 + 2 + 2,
      stops: 3,
      oldest: { number: a?.number },
      shared: [{ name: "Gallon X", units: 4, orders: 3 }],
    });
  });

  it("counts stops as the batch screen groups them", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const first = await pendingOrder({ lines: [{ variation: {} }, { sku: "loose-1" }, {}] });
    const [v, loose] = first.items;
    await pendingOrder({ lines: [{ sameAs: v as never }, { sameAs: loose as never }, {}] });
    await pendingOrder({ lines: [{ sameAs: v as never }, { noProduct: true, sku: "nope" }] });

    const [suggestion] = (await getBatchSuggestions(db, picker)).suggestions;
    const batch = await createBatch(db, picker, {
      idempotencyKey: "stops",
      orders: (suggestion?.orders ?? []).map((o) => ({ id: o.id, expectedVersion: o.version })),
    });

    expect(suggestion?.orders).toHaveLength(3);
    expect(suggestion?.stops).toBe((await getBatch(db, picker, { id: batch.id })).groups.length);
  });

  it("leaves out orders that aren't Pending, others' live claims and nothing to pick", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const [start] = await sharingOrders(1);
    const item = (await db.orderItem.findFirstOrThrow({ where: { orderId: start?.id } })) as never;
    const shared = { lines: [{ sameAs: item }] };

    const mine = await pendingOrder({
      ...shared,
      claimedById: picker.userId,
      claimedAt: minutesAgo(1),
    });
    const lapsed = await pendingOrder({
      ...shared,
      claimedById: other.userId,
      claimedAt: minutesAgo(90),
    });
    await pendingOrder({ ...shared, claimedById: other.userId, claimedAt: minutesAgo(1) });
    await pendingOrder({ ...shared, status: "PICKING" });
    await pendingOrder({ ...shared, status: "ON_HOLD" });
    await pendingOrder({ lines: [{ sameAs: item, voids: [{ quantity: 1 }] }] });
    await pendingOrder({ lines: [{ physical: false, name: "Rush Order" }] });

    const [suggestion] = (await getBatchSuggestions(db, picker)).suggestions;

    expect(suggestion?.orders.map((o) => o.id)).toEqual([
      start?.id,
      mine.order.id,
      lapsed.order.id,
    ]);
  });

  it("uses the batch size and suggestion count settings", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const picker = await createActor(db, ["PICKER"]);
    await updateSettings(db, admin, { pickBatchMaxOrders: 2, pickBatchSuggestionCount: 2 });
    await sharingOrders(7);

    const { suggestions } = await getBatchSuggestions(db, picker);

    expect(suggestions.map((s) => s.orders.length)).toEqual([2, 2]);
  });

  it("reports the picker's open batch", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [a, b, c, d] = await sharingOrders(4);
    const batch = await createBatch(db, picker, {
      idempotencyKey: "open",
      orders: [a, b].map((o) => ({ id: o?.id as string, expectedVersion: o?.version as number })),
    });

    const result = await getBatchSuggestions(db, picker);

    expect(result.openBatch).toEqual({ id: batch.id, number: batch.number });
    // The batch's orders are Picking now: only the rest are suggested.
    expect(result.suggestions[0]?.orders.map((o) => o.id)).toEqual([c?.id, d?.id]);
  });

  it("doesn't report a batch with nothing live left in it", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [a, b] = await sharingOrders(2);
    await createBatch(db, picker, {
      idempotencyKey: "spent",
      orders: [a, b].map((o) => ({ id: o?.id as string, expectedVersion: o?.version as number })),
    });
    await db.order.updateMany({ data: { status: "PACKING" } });

    expect((await getBatchSuggestions(db, picker)).openBatch).toBeNull();
  });

  it("forbids anyone who can't pick", async () => {
    const packer = await createActor(db, ["PACKER"]);
    await expect(getBatchSuggestions(db, packer)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(getBatchSuggestions(db, systemActor)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});
