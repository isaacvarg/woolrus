import type { Db } from "@woolrus/db";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { getPickView, pickLine, unpickLine } from "./service";

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
});
