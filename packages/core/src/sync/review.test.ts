import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import type { UserActor } from "../permissions";
import { getOrder } from "../workflow/queries";
import { syncOrders } from "./orders";
import { applyExternalChange, dismissExternalChange } from "./review";

// Apply / Dismiss of a flagged store change (SPEC-store-sync "Reviewing a flagged change", SC 6).
// Orders are flagged through the real import: import, move along on the floor, edit in the store, poll.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let store: FakeStoreAdapter;
let admin: UserActor;
beforeEach(async () => {
  await resetDb(db);
  store = new FakeStoreAdapter();
  admin = await createActor(db, ["ADMIN"]);
});

async function poll() {
  const result = await syncOrders(db, store, { type: "ORDERS_POLL", now: store.now() });
  if (result.status === "alreadyRunning") throw new Error("unexpected alreadyRunning");
  expect(result.failed).toBe(0);
}

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

type StoreEdit = Parameters<FakeStoreAdapter["editOrder"]>[1];

/**
 * An order with lines 1 (× 3) and 2 (× 1) in Picking, `floor` applied to its lines, then edited in
 * the store and flagged.
 */
async function flagged(
  edit: StoreEdit,
  floor: (lines: Map<number, string>, orderId: string) => Promise<unknown> = async () => {},
) {
  const woo = store.addOrder({
    lines: [
      { id: 1, quantity: 3, name: "Product 1" },
      { id: 2, name: "Product 2" },
    ],
  });
  await poll();
  const order = await db.order.update({
    where: { wooOrderId: woo.id },
    data: { status: "PICKING" },
    include: { items: true },
  });
  await floor(new Map(order.items.map((i) => [i.wooLineItemId, i.id])), order.id);
  store.editOrder(woo.id, edit);
  await poll();
  const after = await reload(order.id);
  expect(after.externalChangeDetectedAt).not.toBeNull();
  return after;
}

const reload = (id: string) =>
  db.order.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { wooLineItemId: "asc" } } },
  });

const pick = (itemId: string | undefined, pickedQuantity: number) =>
  db.orderItem.update({
    where: { id: itemId ?? "" },
    data: { pickStatus: "PICKED", pickedQuantity },
  });

const pack = (orderId: string, itemId: string | undefined, quantity: number) =>
  db.package.create({
    data: { orderId, number: 1, items: { create: [{ orderItemId: itemId ?? "", quantity }] } },
  });

describe("applyExternalChange", () => {
  it("applies header fields and absorbable lines, clears the flag and audits", async () => {
    const order = await flagged(
      {
        shipping: newStreet,
        customer_note: "Leave at the door",
        lines: [{ id: 1, quantity: 5 }, { id: 2 }, { id: 3 }],
      },
      (lines) => pick(lines.get(1), 3),
    );

    const detail = await applyExternalChange(db, admin, {
      orderId: order.id,
      expectedVersion: order.version,
    });

    const after = await reload(order.id);
    expect(detail).toMatchObject({ id: order.id, version: order.version + 1 });
    expect(after).toMatchObject({
      status: "PICKING",
      customerNote: "Leave at the door",
      externalChangeDetectedAt: null,
      externalChangeSummary: null,
    });
    expect(after.shippingAddress).toMatchObject({ address1: "9 New Rd" });
    expect(after.items.map((i) => [i.wooLineItemId, i.quantity, i.pickedQuantity])).toEqual([
      [1, 5, 3],
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(after.items[2]).toMatchObject({ pickStatus: "PENDING" });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityId: order.id, action: "order.externalChange.applied" },
    });
    expect(audit.actorId).toBe(admin.userId);
    expect(audit.before).toMatchObject({ customerNote: null, version: order.version });
    expect(audit.after).toMatchObject({
      customerNote: "Leave at the door",
      lines: { quantity: [{ wooLineItemId: 1, from: 3, to: 5 }] },
    });
  });

  it("drops a quantity down to what's already picked and packed", async () => {
    const order = await flagged({ lines: [{ id: 1, quantity: 2 }, { id: 2 }] }, (lines, id) =>
      Promise.all([pick(lines.get(1), 2), pack(id, lines.get(1), 1)]),
    );

    await applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version });

    expect((await reload(order.id)).items[0]?.quantity).toBe(2);
  });

  it("removes a line nobody has touched", async () => {
    const order = await flagged({ lines: [{ id: 1, quantity: 3 }] });

    await applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version });

    expect((await reload(order.id)).items.map((i) => i.wooLineItemId)).toEqual([1]);
  });

  it("never applies the store's status", async () => {
    const order = await flagged({ status: "on-hold", shipping: newStreet });

    await applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version });

    const after = await reload(order.id);
    expect(after).toMatchObject({ status: "PICKING", externalChangeDetectedAt: null });
    expect(after.shippingAddress).toMatchObject({ address1: "9 New Rd" });
  });

  const refusals: {
    name: string;
    edit: StoreEdit;
    floor: (lines: Map<number, string>, orderId: string) => Promise<unknown>;
    unmet: { messageKey: string; params: Record<string, string | number> };
  }[] = [
    {
      name: "a quantity below what's picked",
      edit: { lines: [{ id: 1, quantity: 1 }, { id: 2 }] },
      floor: (lines) => pick(lines.get(1), 2),
      unmet: {
        messageKey: "errors.sync.unmet.belowPicked",
        params: { line: "Product 1", to: 1, picked: 2 },
      },
    },
    {
      name: "a quantity below what's packed",
      edit: { lines: [{ id: 1, quantity: 1 }, { id: 2 }] },
      floor: (lines, id) => pack(id, lines.get(1), 2),
      unmet: {
        messageKey: "errors.sync.unmet.belowPacked",
        params: { line: "Product 1", to: 1, packed: 2 },
      },
    },
    {
      name: "a quantity drop on a line with a void",
      edit: { lines: [{ id: 1, quantity: 2 }, { id: 2 }] },
      floor: (lines, id) =>
        db.itemVoid.create({
          data: {
            orderId: id,
            orderItemId: lines.get(1) ?? "",
            quantity: 1,
            reason: "Damaged",
            stage: "PICKING",
          },
        }),
      unmet: { messageKey: "errors.sync.unmet.lineVoided", params: { line: "Product 1" } },
    },
    {
      name: "removing a packed line",
      edit: { lines: [{ id: 1, quantity: 3 }] },
      floor: (lines, id) => pack(id, lines.get(2), 1),
      unmet: { messageKey: "errors.sync.unmet.removedStarted", params: { line: "Product 2" } },
    },
    {
      name: "removing a picked line",
      edit: { lines: [{ id: 1, quantity: 3 }] },
      floor: (lines) => pick(lines.get(2), 1),
      unmet: { messageKey: "errors.sync.unmet.removedStarted", params: { line: "Product 2" } },
    },
    {
      name: "removing a line with a note on it",
      edit: { lines: [{ id: 1, quantity: 3 }] },
      floor: (lines, id) =>
        db.note.create({ data: { orderId: id, orderItemId: lines.get(2), content: "Dented" } }),
      unmet: { messageKey: "errors.sync.unmet.removedHasRecords", params: { line: "Product 2" } },
    },
  ];

  it.each(refusals)("refuses $name and changes nothing", async ({ edit, floor, unmet }) => {
    const order = await flagged({ ...edit, shipping: newStreet }, floor);

    await expect(
      applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.sync.cannotApply",
      unmet: [unmet],
    });
    const after = await reload(order.id);
    expect(after).toEqual(order);
  });

  // The QA and Ready gates check packages and labels, not line quantities: a line added there would
  // ship without anyone picking or packing it.
  const pastPacking: [string, Record<string, unknown>][] = [
    ["QA", { status: "QA" }],
    ["Ready", { status: "READY" }],
    ["On Hold from QA", { status: "ON_HOLD", heldFromStatus: "QA", holdReason: "Check" }],
    ["Completed", { status: "COMPLETED" }],
  ];

  it.each(pastPacking)("refuses adding or raising lines once %s", async (_name, data) => {
    const order = await flagged(
      {
        shipping: newStreet,
        lines: [{ id: 1, quantity: 4 }, { id: 2 }, { id: 3, name: "Product 3" }],
      },
      (_lines, id) => db.order.update({ where: { id }, data }),
    );

    await expect(
      applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.sync.cannotApply",
      unmet: [
        { messageKey: "errors.sync.unmet.pastPacking", params: { line: "Product 1" } },
        { messageKey: "errors.sync.unmet.pastPacking", params: { line: "Product 3" } },
      ],
    });
    expect(await reload(order.id)).toEqual(order);
  });

  it("still applies header fields and lowered quantities in QA", async () => {
    const order = await flagged(
      { shipping: newStreet, lines: [{ id: 1, quantity: 2 }, { id: 2 }] },
      (_l, id) => db.order.update({ where: { id }, data: { status: "QA" } }),
    );

    await applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version });

    const after = await reload(order.id);
    expect(after.shippingAddress).toMatchObject({ address1: "9 New Rd" });
    expect(after.items[0]?.quantity).toBe(2);
  });

  it("adds a line while the order is still in Packing", async () => {
    const order = await flagged(
      { lines: [{ id: 1, quantity: 3 }, { id: 2 }, { id: 3, name: "Product 3" }] },
      (_l, id) => db.order.update({ where: { id }, data: { status: "PACKING" } }),
    );

    await applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version });

    expect((await reload(order.id)).items.map((i) => i.wooLineItemId)).toEqual([1, 2, 3]);
  });

  it("refuses a stale version", async () => {
    const order = await flagged({ shipping: newStreet });

    await expect(
      applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version - 1 }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.workflow.stale" });
  });

  it("refuses an order that isn't flagged", async () => {
    const woo = store.addOrder();
    await poll();
    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });

    await expect(
      applyExternalChange(db, admin, { orderId: order.id, expectedVersion: order.version }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.sync.notFlagged" });
  });
});

describe("dismissExternalChange", () => {
  it("clears the flag without changing the order, and audits the reason", async () => {
    const order = await flagged({ shipping: newStreet });

    await dismissExternalChange(db, admin, {
      orderId: order.id,
      expectedVersion: order.version,
      reason: "  Customer called, keep the old address ",
    });

    const after = await reload(order.id);
    expect(after).toMatchObject({
      externalChangeDetectedAt: null,
      // Remembered so the same change doesn't flag again; not a flag (no detectedAt).
      externalChangeSummary: { dismissed: { shippingAddress: { address1: "9 New Rd" } } },
      shippingAddress: order.shippingAddress,
      version: order.version + 1,
    });
    expect((await getOrder(db, admin, { id: order.id })).externalChange).toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityId: order.id, action: "order.externalChange.dismissed" },
    });
    expect(audit.actorId).toBe(admin.userId);
    expect(audit.after).toMatchObject({ reason: "Customer called, keep the old address" });
    expect(audit.before).toMatchObject({ shippingAddress: { to: { address1: "9 New Rd" } } });
  });

  it("stays dismissed through unrelated store edits, and flags again on a new change", async () => {
    const order = await flagged({ shipping: newStreet });
    await dismissExternalChange(db, admin, {
      orderId: order.id,
      expectedVersion: order.version,
      reason: "Keep the old address",
    });

    // Plugins touch orders all the time (export flags, invoice numbers): no tracked change.
    store.editOrder(order.wooOrderId, {
      meta_data: [{ id: 9, key: "_shipstation_exported", value: "yes" }],
    });
    await poll();
    expect((await reload(order.id)).externalChangeDetectedAt).toBeNull();

    store.editOrder(order.wooOrderId, { customer_note: "Ring twice" });
    await poll();
    const again = await reload(order.id);
    expect(again.externalChangeDetectedAt).not.toBeNull();
    // Still "stored vs the store's latest": the dismissed address shows too, so nothing is hidden.
    expect(again.externalChangeSummary).toMatchObject({
      diff: {
        customerNote: { to: "Ring twice" },
        shippingAddress: { to: { address1: "9 New Rd" } },
      },
    });
  });

  it("needs a reason", async () => {
    const order = await flagged({ shipping: newStreet });

    await expect(
      dismissExternalChange(db, admin, {
        orderId: order.id,
        expectedVersion: order.version,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", fields: { reason: "errors.field.required" } });
  });

  it("refuses a stale version", async () => {
    const order = await flagged({ shipping: newStreet });

    await expect(
      dismissExternalChange(db, admin, {
        orderId: order.id,
        expectedVersion: order.version + 1,
        reason: "No",
      }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.workflow.stale" });
  });
});

describe.each(["PICKER", "PACKER", "QA", "SHIPPER"] as const)("as %s", (role) => {
  it("Apply and Dismiss are forbidden", async () => {
    const actor = await createActor(db, [role]);
    const order = await flagged({ shipping: newStreet });
    const input = { orderId: order.id, expectedVersion: order.version };

    await expect(applyExternalChange(db, actor, input)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(dismissExternalChange(db, actor, { ...input, reason: "x" })).rejects.toMatchObject(
      { kind: "FORBIDDEN" },
    );
    expect((await reload(order.id)).externalChangeDetectedAt).not.toBeNull();
  });
});

describe("getOrder", () => {
  it("shows the flagged diff but never the store's incoming data", async () => {
    const order = await flagged({ shipping: newStreet });
    const picker = await createActor(db, ["PICKER"]);

    const view = await getOrder(db, picker, { id: order.id });

    expect(view.externalChange).toMatchObject({
      detectedAt: order.externalChangeDetectedAt,
      diff: { shippingAddress: { to: { address1: "9 New Rd" } } },
    });
    expect(JSON.stringify(view)).not.toContain("incoming");
    expect(JSON.stringify(view)).not.toContain("baseline");
  });

  it("offers Apply / Dismiss only to those allowed", async () => {
    const order = await flagged({ shipping: newStreet });
    const picker = await createActor(db, ["PICKER"]);

    expect((await getOrder(db, admin, { id: order.id })).allowedActions).toContain(
      "resolveExternalChange",
    );
    expect((await getOrder(db, picker, { id: order.id })).allowedActions).not.toContain(
      "resolveExternalChange",
    );
  });

  it("has no external change when not flagged", async () => {
    const woo = store.addOrder();
    await poll();
    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });

    const view = await getOrder(db, admin, { id: order.id });
    expect(view.externalChange).toBeNull();
    expect(view.allowedActions).not.toContain("resolveExternalChange");
  });
});
