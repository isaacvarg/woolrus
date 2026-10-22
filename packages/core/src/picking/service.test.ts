import type { Db } from "@woolrus/db";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { evaluateGate, loadGateSnapshot } from "../workflow/gates";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { getOrder } from "../workflow/queries";
import {
  getPickView,
  markOutOfStock,
  pickLine,
  reconcilePick,
  substitute,
  unpickLine,
} from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/** A Picking order claimed by a fresh picker. */
async function picking(lines: LineSpec[] = [{ quantity: 3 }], claimedAt = new Date()) {
  const picker = await createActor(db, ["PICKER"]);
  const built = await createOrder(db, {
    status: "PICKING",
    version: 2,
    claimedById: picker.userId,
    claimedAt,
    lines,
  });
  return { picker, ...built, item: built.items[0] as (typeof built.items)[0] };
}

const lineRow = (id: string) => db.orderItem.findUniqueOrThrow({ where: { id } });

describe("pickLine", () => {
  it("picks the whole active quantity by default, recording picker and time", async () => {
    const { picker, item } = await picking([{ quantity: 3 }]);

    const result = await pickLine(db, picker, { itemId: item.id });

    expect(result.line).toMatchObject({ id: item.id, pickStatus: "PICKED", pickedQuantity: 3 });
    expect(result.line.pickedBy?.name).toBe("Test User");
    expect(result).toMatchObject({ done: 1, total: 1 });
    expect(await lineRow(item.id)).toMatchObject({
      pickStatus: "PICKED",
      pickedQuantity: 3,
      pickedById: picker.userId,
    });
    expect((await lineRow(item.id)).pickedAt).toBeInstanceOf(Date);
  });

  it("records a partial count as not yet picked", async () => {
    const { picker, item } = await picking([{ quantity: 6 }]);

    const result = await pickLine(db, picker, { itemId: item.id, quantity: 4 });

    expect(result.line).toMatchObject({ pickStatus: "PENDING", pickedQuantity: 4 });
    expect(result).toMatchObject({ done: 0, total: 1 });
  });

  it("measures against the quantity left after voids", async () => {
    const { picker, item } = await picking([{ quantity: 3, voids: [{ quantity: 1 }] }]);

    const result = await pickLine(db, picker, { itemId: item.id, quantity: 2 });

    expect(result.line).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 2, quantity: 2 });
  });

  it("replaces an Out of Stock or Substituted state", async () => {
    const { picker, items } = await picking([
      { quantity: 2, pickStatus: "OUT_OF_STOCK", pickedQuantity: 1 },
      { quantity: 1, pickStatus: "SUBSTITUTED" },
    ]);
    await db.orderItem.update({ where: { id: items[1]?.id }, data: { substitutionNote: "16 oz" } });

    await pickLine(db, picker, { itemId: items[0]?.id as string });
    await pickLine(db, picker, { itemId: items[1]?.id as string });

    expect(await lineRow(items[0]?.id as string)).toMatchObject({
      pickStatus: "PICKED",
      pickedQuantity: 2,
    });
    expect(await lineRow(items[1]?.id as string)).toMatchObject({
      pickStatus: "PICKED",
      substitutionNote: null,
    });
  });

  it("writes one audit event, refreshes the claim and leaves the order's version alone", async () => {
    const { picker, order, item } = await picking([{ quantity: 1 }], minutesAgo(10));

    await pickLine(db, picker, { itemId: item.id });

    expect(await db.auditEvent.findMany({ where: { entityId: item.id } })).toMatchObject([
      {
        entityType: "OrderItem",
        action: "pick.pickLine",
        actorId: picker.userId,
        before: { pickStatus: "PENDING", pickedQuantity: 0 },
        after: { pickStatus: "PICKED", pickedQuantity: 1 },
      },
    ]);
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.version).toBe(2);
    expect(after.claimedAt?.getTime()).toBeGreaterThan(minutesAgo(1).getTime());
  });

  it("tells other screens the order changed, on commit", async () => {
    const { picker, order, item } = await picking();
    const listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    const received: unknown[] = [];
    await listener.connect();
    listener.on("notification", (msg) => received.push(JSON.parse(msg.payload ?? "null")));
    await listener.query(`LISTEN ${ORDER_CHANGED_CHANNEL}`);

    try {
      await pickLine(db, picker, { itemId: item.id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([{ id: order.id, status: "PICKING" }]);
    } finally {
      await listener.end();
    }
  });

  describe("refuses, changing nothing,", () => {
    const unchanged = async (itemId: string) =>
      expect(await lineRow(itemId)).toMatchObject({ pickStatus: "PENDING", pickedQuantity: 0 });

    it("when the order isn't in Picking", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { items } = await createOrder(db, { claimedById: picker.userId });
      const itemId = items[0]?.id as string;

      await expect(pickLine(db, picker, { itemId })).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.notPicking",
      });
      await unchanged(itemId);
    });

    it("when the actor doesn't hold the claim", async () => {
      const { item } = await picking();
      const other = await createActor(db, ["PICKER"]);

      await expect(pickLine(db, other, { itemId: item.id })).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.claimRequired",
      });
      await unchanged(item.id);
    });

    it("when the actor's claim has expired", async () => {
      const { picker, item } = await picking([{}], minutesAgo(31));

      await expect(pickLine(db, picker, { itemId: item.id })).rejects.toMatchObject({
        messageKey: "errors.picking.claimRequired",
      });
      await unchanged(item.id);
    });

    it("for a line nobody picks (not physical)", async () => {
      const { picker, item } = await picking([{ physical: false }]);

      await expect(pickLine(db, picker, { itemId: item.id })).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.lineNotPickable",
      });
      await unchanged(item.id);
    });

    it("for a fully voided line", async () => {
      const { picker, item } = await picking([{ quantity: 2, voids: [{ quantity: 2 }] }]);

      await expect(pickLine(db, picker, { itemId: item.id })).rejects.toMatchObject({
        messageKey: "errors.picking.lineNotPickable",
      });
      await unchanged(item.id);
    });

    it("for more than the active quantity", async () => {
      const { picker, item } = await picking([{ quantity: 3, voids: [{ quantity: 1 }] }]);

      await expect(pickLine(db, picker, { itemId: item.id, quantity: 3 })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
        fields: { quantity: "errors.field.tooBig" },
      });
      await unchanged(item.id);
    });

    it("for a line that doesn't exist", async () => {
      const picker = await createActor(db, ["PICKER"]);

      await expect(
        pickLine(db, picker, { itemId: "00000000-0000-7000-8000-000000000000" }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    });

    it("for someone who can't pick, before reading the line", async () => {
      const { item } = await picking();
      const packer = await createActor(db, ["PACKER"]);

      await expect(pickLine(db, packer, { itemId: item.id })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
      await unchanged(item.id);
    });
  });
});

describe("unpickLine", () => {
  it("puts the line back to not picked and clears who picked it", async () => {
    const { picker, item } = await picking([{ quantity: 2 }]);
    await pickLine(db, picker, { itemId: item.id });

    const result = await unpickLine(db, picker, { itemId: item.id });

    expect(result.line).toMatchObject({ pickStatus: "PENDING", pickedQuantity: 0, pickedBy: null });
    expect(await lineRow(item.id)).toMatchObject({
      pickStatus: "PENDING",
      pickedQuantity: 0,
      pickedById: null,
      pickedAt: null,
      substitutionNote: null,
    });
    expect(result).toMatchObject({ done: 0, total: 1 });
  });

  it("is audited as pick.unpickLine", async () => {
    const { picker, item } = await picking();
    await pickLine(db, picker, { itemId: item.id });

    await unpickLine(db, picker, { itemId: item.id });

    const actions = (await db.auditEvent.findMany({ where: { entityId: item.id } })).map(
      (a) => a.action,
    );
    expect(actions.sort()).toEqual(["pick.pickLine", "pick.unpickLine"]);
  });

  it("is forbidden for someone who can't pick", async () => {
    const { item } = await picking();
    const qa = await createActor(db, ["QA"]);

    await expect(unpickLine(db, qa, { itemId: item.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("is refused once the order has left Picking", async () => {
    const { picker, order, item } = await picking([{ pickStatus: "PICKED" }]);
    await db.order.update({ where: { id: order.id }, data: { status: "PACKING" } });

    await expect(unpickLine(db, picker, { itemId: item.id })).rejects.toMatchObject({
      messageKey: "errors.picking.notPicking",
    });
  });
});

describe("getPickView", () => {
  it("lists the lines to pick in pick order and hides the ones nobody picks", async () => {
    const { picker, order } = await picking([
      { name: "Zinc cream", bin: "B2" },
      { name: "Aloe gel" },
      { name: "Clay mask", bin: "A10" },
      { name: "Rush Order", physical: false },
      { name: "Voided soap", quantity: 1, voids: [{ quantity: 1 }] },
      { name: "Beeswax", bin: "A2" },
    ]);

    const view = await getPickView(db, picker, { orderId: order.id });

    expect(view.lines.map((l) => l.name)).toEqual([
      "Beeswax",
      "Clay mask",
      "Zinc cream",
      "Aloe gel",
    ]);
    expect(view.voidedLines).toBe(1);
    expect(view.lines[0]).toMatchObject({ binLocation: "A2", noteCount: 0 });
  });

  it("is forbidden without order.read", async () => {
    const { order } = await picking();
    const nobody = await createActor(db, []);

    await expect(getPickView(db, nobody, { orderId: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("counts lines done and says what the picked gate still needs", async () => {
    const { picker, order } = await picking([
      { name: "Aloe gel", pickStatus: "PICKED" },
      { name: "Clay mask", quantity: 2 },
    ]);

    const view = await getPickView(db, picker, { orderId: order.id });

    expect(view).toMatchObject({ done: 1, total: 2 });
    expect(view.unmet).toEqual([
      { messageKey: "errors.workflow.gate.lineNotPicked", params: { line: "Clay mask" } },
    ]);
    expect(view.order).toMatchObject({ id: order.id, status: "PICKING", version: 2 });
    expect(view.order.claim?.userId).toBe(picker.userId);
  });

  it("is open to anyone who can read orders", async () => {
    const { order } = await picking();
    const packer = await createActor(db, ["PACKER"]);

    await expect(getPickView(db, packer, { orderId: order.id })).resolves.toMatchObject({
      total: 1,
    });
  });

  it("shows the customer note", async () => {
    const { picker, order } = await picking();
    await db.order.update({ where: { id: order.id }, data: { customerNote: "Gift wrap" } });

    const view = await getPickView(db, picker, { orderId: order.id });

    expect(view.customerNote).toBe("Gift wrap");
  });

  it("names the open batch the order is in, and not one it was removed from or that closed", async () => {
    const { picker, order } = await picking();
    const ownerId = picker.userId as string;
    const batch = await db.pickBatch.create({
      data: { ownerId, orders: { create: [{ orderId: order.id, slot: 3 }] } },
    });

    const view = await getPickView(db, picker, { orderId: order.id });
    expect(view.batch).toEqual({ id: batch.id, number: batch.number, slot: 3 });

    await db.pickBatchOrder.updateMany({
      where: { orderId: order.id },
      data: { removedAt: new Date() },
    });
    expect((await getPickView(db, picker, { orderId: order.id })).batch).toBeNull();

    // A closed batch whose row wasn't marked removed still doesn't count.
    await db.pickBatchOrder.updateMany({ where: { orderId: order.id }, data: { removedAt: null } });
    await db.pickBatch.update({ where: { id: batch.id }, data: { closedAt: new Date() } });
    expect((await getPickView(db, picker, { orderId: order.id })).batch).toBeNull();
  });
});

let keySeq = 0;
const key = () => {
  keySeq += 1;
  return `pick-key-${keySeq}`;
};

const lineNotes = (orderItemId: string) =>
  db.note.findMany({ where: { orderItemId }, orderBy: { createdAt: "asc" } });

const pickedGate = async (orderId: string) =>
  evaluateGate("picked", await loadGateSnapshot(db, orderId));

describe("markOutOfStock", () => {
  it("records what was found and writes one internal note on the line", async () => {
    const { picker, item } = await picking([{ name: "Clay mask", quantity: 3 }]);

    const result = await markOutOfStock(db, picker, {
      itemId: item.id,
      foundQuantity: 1,
      note: "Only one on the shelf",
      idempotencyKey: key(),
    });

    expect(result.line).toMatchObject({ pickStatus: "OUT_OF_STOCK", pickedQuantity: 1 });
    expect(result).toMatchObject({ done: 0, total: 1 });
    expect(await lineRow(item.id)).toMatchObject({
      pickStatus: "OUT_OF_STOCK",
      pickedQuantity: 1,
      pickedById: picker.userId,
    });
    expect(await lineNotes(item.id)).toMatchObject([
      { content: "Only one on the shelf", visibility: "INTERNAL", authorId: picker.userId },
    ]);
    expect(result.line.noteCount).toBe(1);
    const actions = (await db.auditEvent.findMany({ where: { entityId: item.id } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(["pick.markOutOfStock"]);
  });

  it("writes no second note on a replay of the same key", async () => {
    const { picker, item } = await picking([{ quantity: 2 }]);
    const input = { itemId: item.id, foundQuantity: 0, note: "None left", idempotencyKey: key() };

    await markOutOfStock(db, picker, input);
    const replay = await markOutOfStock(db, picker, input);

    expect(replay.line).toMatchObject({ pickStatus: "OUT_OF_STOCK", pickedQuantity: 0 });
    expect(await lineNotes(item.id)).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { entityId: item.id } })).toBe(1);
  });

  it("answers a replay with the line it wrote, and refuses the key for another line", async () => {
    const { picker, items } = await picking([
      { name: "Clay mask", quantity: 2 },
      { name: "Aloe gel", quantity: 2 },
    ]);
    const [mask, aloe] = items as [(typeof items)[0], (typeof items)[0]];
    const input = { itemId: mask.id, foundQuantity: 1, note: "One short", idempotencyKey: key() };
    await markOutOfStock(db, picker, input);

    const replay = await markOutOfStock(db, picker, input);
    expect(replay.line).toMatchObject({ id: mask.id, pickStatus: "OUT_OF_STOCK" });

    await expect(markOutOfStock(db, picker, { ...input, itemId: aloe.id })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.conflict",
    });
    expect(await lineRow(aloe.id)).toMatchObject({ pickStatus: "PENDING" });
  });

  it("replays a duplicate sent at the same moment instead of failing it", async () => {
    const { picker, item } = await picking([{ quantity: 2 }]);
    const input = { itemId: item.id, foundQuantity: 0, note: "None left", idempotencyKey: key() };

    const results = await Promise.all([
      markOutOfStock(db, picker, input),
      markOutOfStock(db, picker, input),
    ]);

    expect(results.map((r) => r.line.pickStatus)).toEqual(["OUT_OF_STOCK", "OUT_OF_STOCK"]);
    expect(await lineNotes(item.id)).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { entityId: item.id } })).toBe(1);
  });

  it("blocks the picked gate until the line is picked or substituted", async () => {
    const { picker, order, item } = await picking([{ name: "Clay mask", quantity: 2 }]);
    await markOutOfStock(db, picker, {
      itemId: item.id,
      foundQuantity: 0,
      note: "Gone",
      idempotencyKey: key(),
    });

    expect(await pickedGate(order.id)).toEqual([
      { messageKey: "errors.workflow.gate.lineOutOfStock", params: { line: "Clay mask" } },
    ]);

    await substitute(db, picker, {
      itemId: item.id,
      substitute: "16 oz jar",
      idempotencyKey: key(),
    });
    expect(await pickedGate(order.id)).toEqual([]);
  });

  it("is replaced by a later pick", async () => {
    const { picker, order, item } = await picking([{ quantity: 2 }]);
    await markOutOfStock(db, picker, {
      itemId: item.id,
      foundQuantity: 1,
      note: "One short",
      idempotencyKey: key(),
    });

    await pickLine(db, picker, { itemId: item.id });

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 2 });
    expect(await pickedGate(order.id)).toEqual([]);
  });

  describe("refuses, changing nothing,", () => {
    const unchanged = async (itemId: string) => {
      expect(await lineRow(itemId)).toMatchObject({ pickStatus: "PENDING", pickedQuantity: 0 });
      expect(await lineNotes(itemId)).toHaveLength(0);
    };

    it("when found is the whole active quantity", async () => {
      const { picker, item } = await picking([{ quantity: 3, voids: [{ quantity: 1 }] }]);

      await expect(
        markOutOfStock(db, picker, {
          itemId: item.id,
          foundQuantity: 2,
          note: "x",
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({
        kind: "BAD_REQUEST",
        fields: { foundQuantity: "errors.field.tooBig" },
      });
      await unchanged(item.id);
    });

    it("when the actor doesn't hold the claim", async () => {
      const { item } = await picking();
      const other = await createActor(db, ["PICKER"]);

      await expect(
        markOutOfStock(db, other, {
          itemId: item.id,
          foundQuantity: 0,
          note: "x",
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.claimRequired" });
      await unchanged(item.id);
    });

    it("when the order isn't in Picking", async () => {
      const { picker, order, item } = await picking();
      await db.order.update({ where: { id: order.id }, data: { status: "PACKING" } });

      await expect(
        markOutOfStock(db, picker, {
          itemId: item.id,
          foundQuantity: 0,
          note: "x",
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.notPicking" });
      await unchanged(item.id);
    });

    it("for a line nobody picks", async () => {
      const { picker, item } = await picking([{ physical: false }]);

      await expect(
        markOutOfStock(db, picker, {
          itemId: item.id,
          foundQuantity: 0,
          note: "x",
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.lineNotPickable" });
      await unchanged(item.id);
    });

    it("for someone who can't pick", async () => {
      const { item } = await picking();
      const packer = await createActor(db, ["PACKER"]);

      await expect(
        markOutOfStock(db, packer, {
          itemId: item.id,
          foundQuantity: 0,
          note: "x",
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await unchanged(item.id);
    });
  });
});

describe("substitute", () => {
  it("counts the line as picked, keeps what went in and notes it on the line", async () => {
    const { picker, item } = await picking([{ quantity: 2 }]);

    const result = await substitute(db, picker, {
      itemId: item.id,
      substitute: "One 16 oz jar",
      note: "Customer asked for fewer jars",
      idempotencyKey: key(),
    });

    expect(result.line).toMatchObject({
      pickStatus: "SUBSTITUTED",
      pickedQuantity: 2,
      substitutionNote: "One 16 oz jar",
    });
    expect(result).toMatchObject({ done: 1, total: 1 });
    expect(await lineNotes(item.id)).toMatchObject([
      {
        content: "Substituted: One 16 oz jar\nCustomer asked for fewer jars",
        visibility: "INTERNAL",
      },
    ]);
  });

  it("writes the note without the optional text, once per key", async () => {
    const { picker, item } = await picking();
    const input = { itemId: item.id, substitute: "Rose soap", idempotencyKey: key() };

    await substitute(db, picker, input);
    await substitute(db, picker, input);

    expect(await lineNotes(item.id)).toMatchObject([{ content: "Substituted: Rose soap" }]);
  });

  it("answers a replay with the line it wrote, and refuses the key for another line", async () => {
    const { picker, items } = await picking([{ name: "Clay mask" }, { name: "Aloe gel" }]);
    const [mask, aloe] = items as [(typeof items)[0], (typeof items)[0]];
    const input = { itemId: mask.id, substitute: "Rose soap", idempotencyKey: key() };
    await substitute(db, picker, input);

    expect((await substitute(db, picker, input)).line).toMatchObject({
      id: mask.id,
      pickStatus: "SUBSTITUTED",
    });
    await expect(substitute(db, picker, { ...input, itemId: aloe.id })).rejects.toMatchObject({
      messageKey: "errors.conflict",
    });
    expect(await lineRow(aloe.id)).toMatchObject({ pickStatus: "PENDING" });
  });

  it("replays a duplicate sent at the same moment instead of failing it", async () => {
    const { picker, item } = await picking();
    const input = { itemId: item.id, substitute: "Rose soap", idempotencyKey: key() };

    await Promise.all([substitute(db, picker, input), substitute(db, picker, input)]);

    expect(await lineNotes(item.id)).toHaveLength(1);
  });

  it("shows on the order detail line", async () => {
    const { picker, order, item } = await picking();
    await substitute(db, picker, {
      itemId: item.id,
      substitute: "Rose soap",
      idempotencyKey: key(),
    });

    const detail = await getOrder(db, picker, { id: order.id });

    expect(detail.lines.find((l) => l.id === item.id)).toMatchObject({
      pickStatus: "SUBSTITUTED",
      substitutionNote: "Rose soap",
    });
  });

  it("replaces an Out of Stock state", async () => {
    const { picker, item } = await picking([
      { quantity: 2, pickStatus: "OUT_OF_STOCK", pickedQuantity: 1 },
    ]);

    await substitute(db, picker, {
      itemId: item.id,
      substitute: "Rose soap",
      idempotencyKey: key(),
    });

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "SUBSTITUTED", pickedQuantity: 2 });
  });

  it("is refused for someone who can't pick, or without the claim", async () => {
    const { item } = await picking();
    const qa = await createActor(db, ["QA"]);
    const other = await createActor(db, ["PICKER"]);

    await expect(
      substitute(db, qa, { itemId: item.id, substitute: "x", idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(
      substitute(db, other, { itemId: item.id, substitute: "x", idempotencyKey: key() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.claimRequired" });
    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PENDING", substitutionNote: null });
    expect(await lineNotes(item.id)).toHaveLength(0);
  });
});

describe("reconcilePick", () => {
  const voidUnits = (orderId: string, orderItemId: string, quantity: number) =>
    db.itemVoid.create({
      data: { orderId, orderItemId, quantity, reason: "test void", stage: "PICKING" },
    });
  const reconcile = (itemId: string) => db.$transaction((tx) => reconcilePick(tx, itemId));

  it("clamps a picked count above the active quantity, which leaves the line picked", async () => {
    const { order, item } = await picking([{ quantity: 3, pickedQuantity: 2 }]);
    await voidUnits(order.id, item.id, 2);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 1 });
  });

  it("turns a partly picked line into Picked once its remaining units are voided", async () => {
    const { order, item } = await picking([{ quantity: 3, pickedQuantity: 1 }]);
    await voidUnits(order.id, item.id, 2);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 1 });
    expect(await pickedGate(order.id)).toEqual([]);
  });

  it("leaves an untouched line pending when it is voided entirely", async () => {
    const { order, item } = await picking([{ quantity: 2 }]);
    await voidUnits(order.id, item.id, 2);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PENDING", pickedQuantity: 0 });
  });

  it("clamps an Out of Stock found count above the new active quantity, then Picked", async () => {
    const { order, item } = await picking([
      { quantity: 3, pickStatus: "OUT_OF_STOCK", pickedQuantity: 2 },
    ]);
    await voidUnits(order.id, item.id, 2);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 1 });
  });

  it("keeps an Out of Stock line that is still short after a partial void", async () => {
    const { order, item } = await picking([
      { quantity: 4, pickStatus: "OUT_OF_STOCK", pickedQuantity: 1 },
    ]);
    await voidUnits(order.id, item.id, 1);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "OUT_OF_STOCK", pickedQuantity: 1 });
  });

  it("turns a partial Out of Stock into Picked once the rest is voided, and the order passes picked", async () => {
    const { picker, order, item } = await picking([{ name: "Clay mask", quantity: 3 }]);
    await markOutOfStock(db, picker, {
      itemId: item.id,
      foundQuantity: 1,
      note: "Only one",
      idempotencyKey: key(),
    });
    await voidUnits(order.id, item.id, 2);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 1 });
    expect(await pickedGate(order.id)).toEqual([]);
  });

  it("puts a Picked line back to pending when a void is undone", async () => {
    const { order, item } = await picking([
      {
        quantity: 3,
        pickStatus: "PICKED",
        pickedQuantity: 1,
        voids: [{ quantity: 2, undone: true }],
      },
    ]);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "PENDING", pickedQuantity: 1 });
    expect(await pickedGate(order.id)).toMatchObject([
      { messageKey: "errors.workflow.gate.lineNotPicked" },
    ]);
  });

  it("keeps a Substituted line at its active quantity", async () => {
    const { order, item } = await picking([{ quantity: 3, pickStatus: "SUBSTITUTED" }]);
    await voidUnits(order.id, item.id, 1);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "SUBSTITUTED", pickedQuantity: 2 });

    await db.itemVoid.updateMany({
      where: { orderItemId: item.id },
      data: { undoneAt: new Date() },
    });
    await reconcile(item.id);
    expect(await lineRow(item.id)).toMatchObject({ pickStatus: "SUBSTITUTED", pickedQuantity: 3 });
  });

  it("leaves a consistent line alone", async () => {
    const { item } = await picking([{ quantity: 2, pickedQuantity: 1 }]);
    const before = await lineRow(item.id);

    await reconcile(item.id);

    expect(await lineRow(item.id)).toEqual(before);
  });
});
