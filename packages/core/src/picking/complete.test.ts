import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import type { UserActor } from "../permissions";
import { completePick } from "./complete";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

/** A Picking order claimed by `picker` (a fresh Picker by default), every line picked. */
async function picked(
  picker?: UserActor,
  lines: LineSpec[] = [{ quantity: 2, pickStatus: "PICKED" }],
) {
  const actor = picker ?? (await createActor(db, ["PICKER"]));
  const { order } = await createOrder(db, {
    status: "PICKING",
    version: 2,
    claimedById: actor.userId,
    lines,
  });
  return { picker: actor, order };
}

const pending = (priority: number, orderedAt: Date) =>
  createOrder(db, { status: "PENDING", priority, orderedAt }).then((b) => b.order);

describe("completePick", () => {
  it("queue: moves the order to Packing with no claim and nothing else", async () => {
    const { picker, order } = await picked();
    const other = await pending(0, minutesAgo(5));

    const result = await completePick(db, picker, {
      orderId: order.id,
      expectedVersion: 2,
      after: "queue",
    });

    expect(result).toEqual({ nextOrderId: null });
    expect(await orderRow(order.id)).toMatchObject({ status: "PACKING", claimedById: null });
    expect(await orderRow(other.id)).toMatchObject({ status: "PENDING", claimedById: null });
  });

  it("next: begins the first unclaimed Pending order in queue order", async () => {
    const { picker, order } = await picked();
    const someone = await createActor(db, ["PICKER"]);
    await pending(0, minutesAgo(60)); // oldest, but lower priority
    const urgentClaimed = await createOrder(db, {
      status: "PENDING",
      priority: 2,
      orderedAt: minutesAgo(30),
      claimedById: someone.userId,
    });
    const urgentLater = await pending(2, minutesAgo(10));
    const urgentFirst = await pending(2, minutesAgo(20));

    const result = await completePick(db, picker, {
      orderId: order.id,
      expectedVersion: 2,
      after: "next",
    });

    expect(result).toEqual({ nextOrderId: urgentFirst.id });
    expect(await orderRow(order.id)).toMatchObject({ status: "PACKING" });
    expect(await orderRow(urgentFirst.id)).toMatchObject({
      status: "PICKING",
      claimedById: picker.userId,
      version: 2,
    });
    expect(await orderRow(urgentLater.id)).toMatchObject({ status: "PENDING" });
    expect(await orderRow(urgentClaimed.order.id)).toMatchObject({
      status: "PENDING",
      claimedById: someone.userId,
    });
  });

  it("next: takes an order whose claim has expired", async () => {
    const { picker, order } = await picked();
    const someone = await createActor(db, ["PICKER"]);
    const { order: stale } = await createOrder(db, {
      status: "PENDING",
      claimedById: someone.userId,
      claimedAt: minutesAgo(24 * 60),
    });

    const result = await completePick(db, picker, {
      orderId: order.id,
      expectedVersion: 2,
      after: "next",
    });

    expect(result).toEqual({ nextOrderId: stale.id });
    expect(await orderRow(stale.id)).toMatchObject({
      status: "PICKING",
      claimedById: picker.userId,
    });
  });

  it("next: returns null when the Pending queue is empty, and still completes", async () => {
    const { picker, order } = await picked();

    const result = await completePick(db, picker, {
      orderId: order.id,
      expectedVersion: 2,
      after: "next",
    });

    expect(result).toEqual({ nextOrderId: null });
    expect(await orderRow(order.id)).toMatchObject({ status: "PACKING" });
  });

  it("next: two pickers finishing at once get different orders", async () => {
    const a = await picked();
    const b = await picked();
    const first = await pending(0, minutesAgo(20));
    const second = await pending(0, minutesAgo(10));

    const results = await Promise.all([
      completePick(db, a.picker, { orderId: a.order.id, expectedVersion: 2, after: "next" }),
      completePick(db, b.picker, { orderId: b.order.id, expectedVersion: 2, after: "next" }),
    ]);

    const ids = results.map((r) => r.nextOrderId);
    expect(new Set(ids)).toEqual(new Set([first.id, second.id]));
    for (const [i, { picker }] of [a, b].entries()) {
      expect(await orderRow(ids[i] as string)).toMatchObject({
        status: "PICKING",
        claimedById: picker.userId,
      });
    }
  });

  it("next: skips an order another transaction has locked instead of waiting for it", async () => {
    const { picker, order } = await picked();
    const first = await pending(0, minutesAgo(20));
    const second = await pending(0, minutesAgo(10));

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another picker's completePick, mid-transaction, holding the first Pending order.
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${first.id}::uuid FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await isLocked;

    const result = await Promise.race([
      completePick(db, picker, { orderId: order.id, expectedVersion: 2, after: "next" }),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
    ]);
    release();
    await holder;

    expect(result).toEqual({ nextOrderId: second.id });
  });

  it("next: with one order left, two pickers at once give it to exactly one", async () => {
    const a = await picked();
    const b = await picked();
    const only = await pending(0, minutesAgo(10));

    const results = await Promise.all([
      completePick(db, a.picker, { orderId: a.order.id, expectedVersion: 2, after: "next" }),
      completePick(db, b.picker, { orderId: b.order.id, expectedVersion: 2, after: "next" }),
    ]);

    expect(results.map((r) => r.nextOrderId).sort()).toEqual([null, only.id].sort());
  });

  it("pack: leaves the order in Packing claimed by the actor", async () => {
    const both = await createActor(db, ["PICKER", "PACKER"]);
    const { order } = await picked(both);

    const result = await completePick(db, both, {
      orderId: order.id,
      expectedVersion: 2,
      after: "pack",
    });

    expect(result).toEqual({ nextOrderId: null });
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: "PACKING", claimedById: both.userId, version: 4 });
    expect(row.claimedAt).toBeInstanceOf(Date);
  });

  it("pack: is forbidden without order.pack, and nothing moves", async () => {
    const { picker, order } = await picked();

    await expect(
      completePick(db, picker, { orderId: order.id, expectedVersion: 2, after: "pack" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await orderRow(order.id)).toMatchObject({ status: "PICKING", version: 2 });
  });

  it.each(["queue", "next", "pack"] as const)("%s: a gate failure moves nothing", async (after) => {
    const both = await createActor(db, ["PICKER", "PACKER"]);
    const { order } = await picked(both, [{ name: "Clay mask", quantity: 2 }]);
    const waiting = await pending(0, minutesAgo(10));

    await expect(
      completePick(db, both, { orderId: order.id, expectedVersion: 2, after }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.gateFailed",
      unmet: [{ messageKey: "errors.workflow.gate.lineNotPicked", params: { line: "Clay mask" } }],
    });
    expect(await orderRow(order.id)).toMatchObject({
      status: "PICKING",
      version: 2,
      claimedById: both.userId,
    });
    expect(await orderRow(waiting.id)).toMatchObject({ status: "PENDING", claimedById: null });
  });

  it.each(["queue", "next", "pack"] as const)(
    "%s: a stale version fails and moves nothing",
    async (after) => {
      const both = await createActor(db, ["PICKER", "PACKER"]);
      const { order } = await picked(both);
      const waiting = await pending(0, minutesAgo(10));

      await expect(
        completePick(db, both, { orderId: order.id, expectedVersion: 1, after }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.workflow.stale" });
      expect(await orderRow(order.id)).toMatchObject({ status: "PICKING", version: 2 });
      expect(await orderRow(waiting.id)).toMatchObject({ status: "PENDING" });
    },
  );

  it("is forbidden to someone who can't pick", async () => {
    const { order } = await picked();
    const packer = await createActor(db, ["PACKER"]);

    await expect(
      completePick(db, packer, { orderId: order.id, expectedVersion: 2, after: "queue" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await orderRow(order.id)).toMatchObject({ status: "PICKING" });
  });

  it("needs the actor's live claim", async () => {
    const { order } = await picked();
    const otherPicker = await createActor(db, ["PICKER"]);

    await expect(
      completePick(db, otherPicker, { orderId: order.id, expectedVersion: 2, after: "next" }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.workflow.claimRequired" });
  });
});
