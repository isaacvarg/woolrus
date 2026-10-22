import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import type { UserActor } from "../permissions";
import { completeBatchMembers, finishBatch, removeFromBatch } from "./batch-complete";
import { createBatch, getBatch, myPicks } from "./batches";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
let keys = 0;
const key = () => `batch-complete-key-${++keys}`;
const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

/** A batch of Pending orders, one per line spec, slots in creation order. */
async function batchOf(picker: UserActor, lines: LineSpec[]) {
  const orders = [];
  for (const [i, line] of lines.entries()) {
    orders.push((await createOrder(db, { orderedAt: minutesAgo(100 - i), lines: [line] })).order);
  }
  return createBatch(db, picker, {
    orders: orders.map((o) => ({ id: o.id, expectedVersion: o.version })),
    idempotencyKey: key(),
  });
}

const picked: LineSpec = { pickStatus: "PICKED" };
const refsOf = (members: { orderId: string; version: number }[]) =>
  members.map((m) => ({ id: m.orderId, expectedVersion: m.version }));

describe("completeBatchMembers", () => {
  it("moves the ready orders and reports the unmet list of the one that isn't", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [picked, { name: "Blue yarn" }, picked]);
    const [a, b, c] = batch.members.map((m) => m.orderId);

    const { results, batch: after } = await completeBatchMembers(db, picker, {
      id: batch.id,
      orders: refsOf(batch.members),
    });

    expect(results).toEqual([
      { orderId: a, moved: true },
      {
        orderId: b,
        moved: false,
        messageKey: "errors.workflow.gateFailed",
        params: {},
        unmet: [
          { messageKey: "errors.workflow.gate.lineNotPicked", params: { line: "Blue yarn" } },
        ],
      },
      { orderId: c, moved: true },
    ]);
    expect((await orderRow(a as string)).status).toBe("PACKING");
    expect((await orderRow(b as string)).status).toBe("PICKING");
    expect((await orderRow(c as string)).status).toBe("PACKING");
    // Each move is workflow's completePicking: an event and an audit per order.
    expect(await db.orderStageEvent.count({ where: { toStatus: "PACKING" } })).toBe(2);
    expect(after.closedAt).toBeNull();
    expect(after.members.map((m) => m.state)).toEqual(["left", "live", "left"]);
  });

  it("closes the batch once the last live order moves", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [picked, picked]);

    const { batch: after } = await completeBatchMembers(db, picker, {
      id: batch.id,
      orders: refsOf(batch.members),
    });

    expect(after.closedAt).toBeInstanceOf(Date);
    expect(await db.pickBatchOrder.count({ where: { removedAt: null } })).toBe(0);
    expect((await myPicks(db, picker)).batch).toBeNull();
  });

  it("reports a stale version and an order that isn't live in the batch, moving the rest", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [picked, picked, picked]);
    const [a, b, c] = batch.members;
    await removeFromBatch(db, picker, { id: batch.id, orderId: c?.orderId as string });
    const [stranger] = [
      (await createOrder(db, { status: "PICKING", claimedById: picker.userId })).order,
    ];

    const { results } = await completeBatchMembers(db, picker, {
      id: batch.id,
      orders: [
        { id: a?.orderId as string, expectedVersion: (a?.version as number) - 1 },
        { id: b?.orderId as string, expectedVersion: b?.version as number },
        { id: c?.orderId as string, expectedVersion: c?.version as number },
        { id: stranger?.id as string, expectedVersion: stranger?.version as number },
      ],
    });

    expect(results.map((r) => (r.moved ? "moved" : r.messageKey))).toEqual([
      "errors.workflow.stale",
      "moved",
      "errors.picking.notInBatch",
      "errors.picking.notInBatch",
    ]);
    expect((await orderRow(c?.orderId as string)).status).toBe("PICKING");
    expect((await orderRow(stranger?.id as string)).status).toBe("PICKING");
  });

  it("lets only the owner complete, and not on a finished batch", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [picked, picked]);
    const input = { id: batch.id, orders: refsOf(batch.members) };

    await expect(completeBatchMembers(db, other, input)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const packer = await createActor(db, ["PACKER"]);
    await expect(completeBatchMembers(db, packer, input)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await finishBatch(db, picker, { id: batch.id });
    await expect(completeBatchMembers(db, picker, input)).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.picking.batchClosed",
    });
    expect(await db.order.count({ where: { status: "PACKING" } })).toBe(0);
  });
});

describe("removeFromBatch", () => {
  it("drops the order from the batch; it stays in Picking with the picker's claim", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [{}, {}, {}]);
    const [, removed] = batch.members;
    const before = await orderRow(removed?.orderId as string);

    const after = await removeFromBatch(db, picker, {
      id: batch.id,
      orderId: removed?.orderId as string,
    });

    expect(after.members.map((m) => m.state)).toEqual(["live", "removed", "live"]);
    expect(after.groups.flatMap((g) => g.chips.map((c) => c.slot))).not.toContain(2);
    expect(await orderRow(removed?.orderId as string)).toMatchObject({
      status: "PICKING",
      claimedById: picker.userId,
      version: before.version,
    });
    expect(await db.auditEvent.count({ where: { action: "pickBatch.removeOrder" } })).toBe(1);
    // It's one of my picks again, on its own.
    expect((await myPicks(db, picker)).orders.map((o) => o.id)).toEqual([removed?.orderId]);
  });

  it("is harmless to replay, and closes the batch when nothing live is left", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [{}, {}]);
    const [a, b] = batch.members.map((m) => m.orderId) as [string, string];

    await removeFromBatch(db, picker, { id: batch.id, orderId: a });
    const replay = await removeFromBatch(db, picker, { id: batch.id, orderId: a });
    expect(replay.closedAt).toBeNull();
    expect(await db.auditEvent.count({ where: { action: "pickBatch.removeOrder" } })).toBe(1);

    const last = await removeFromBatch(db, picker, { id: batch.id, orderId: b });
    expect(last.closedAt).toBeInstanceOf(Date);
  });

  it("refuses an order that isn't in the batch, and anyone but the owner", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [{}, {}]);
    const outsider = (await createOrder(db)).order;

    await expect(
      removeFromBatch(db, picker, { id: batch.id, orderId: outsider.id }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(
      removeFromBatch(db, other, { id: batch.id, orderId: batch.members[0]?.orderId as string }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await db.pickBatchOrder.count({ where: { removedAt: { not: null } } })).toBe(0);
  });
});

describe("finishBatch", () => {
  it("closes the batch and frees its orders, which stay in Picking with the picker", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [picked, {}]);

    const after = await finishBatch(db, picker, { id: batch.id });

    expect(after.closedAt).toBeInstanceOf(Date);
    expect(await db.pickBatchOrder.count({ where: { removedAt: null } })).toBe(0);
    for (const m of batch.members) {
      expect(await orderRow(m.orderId)).toMatchObject({
        status: "PICKING",
        claimedById: picker.userId,
      });
    }
    expect(await db.auditEvent.count({ where: { action: "pickBatch.finish" } })).toBe(1);
    const picks = await myPicks(db, picker);
    expect(picks.batch).toBeNull();
    expect(picks.orders).toHaveLength(2);
    // The picker can start another batch with the same orders.
    const again = await createBatch(db, picker, {
      orders: refsOf(batch.members),
      idempotencyKey: key(),
    });
    expect(again.id).not.toBe(batch.id);
  });

  it("is harmless to replay and refused to anyone but the owner", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const batch = await batchOf(picker, [{}, {}]);

    await expect(finishBatch(db, other, { id: batch.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const first = await finishBatch(db, picker, { id: batch.id });
    const replay = await finishBatch(db, picker, { id: batch.id });

    expect(replay.closedAt).toEqual(first.closedAt);
    expect(await db.auditEvent.count({ where: { action: "pickBatch.finish" } })).toBe(1);
    await expect(
      finishBatch(db, picker, { id: "01900000-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("one open batch per order", () => {
  it("takes an order out of its old batch when it joins a new one", async () => {
    const ana = await createActor(db, ["PICKER"]);
    const ben = await createActor(db, ["PICKER"]);
    const old = await batchOf(ana, [{}, {}, {}]);
    const moved = old.members[2] as (typeof old.members)[number];
    // Ben takes the order over, then batches it with one of his own.
    await db.order.update({
      where: { id: moved.orderId },
      data: { claimedById: ben.userId, claimedAt: new Date() },
    });
    const own = (await createOrder(db)).order;

    const fresh = await createBatch(db, ben, {
      orders: [
        { id: moved.orderId, expectedVersion: moved.version },
        { id: own.id, expectedVersion: own.version },
      ],
      idempotencyKey: key(),
    });

    expect(fresh.members.map((m) => m.orderId)).toContain(moved.orderId);
    const read = await getBatch(db, ana, { id: old.id });
    expect(read.closedAt).toBeNull();
    expect(read.members.map((m) => m.state)).toEqual(["live", "live", "removed"]);
    expect(
      await db.pickBatchOrder.count({ where: { orderId: moved.orderId, removedAt: null } }),
    ).toBe(1);
  });
});
