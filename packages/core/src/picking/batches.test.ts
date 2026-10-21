import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { systemActor, type UserActor } from "../permissions";
import { updateSettings } from "../settings/service";
import { createBatch, getBatch, myPicks } from "./batches";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/**
 * Concurrency tests need the settings row to exist already: creating it on first use makes the
 * second transaction wait for the first, which would hide the race they test.
 */
const settingsRow = () => db.settings.create({ data: { id: 1 } });

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
let keys = 0;
const key = () => `batch-key-${++keys}`;

/** Pending orders, oldest first, so queue order is creation order unless a test sets priority. */
async function pending(count: number, spec: Parameters<typeof createOrder>[1] = {}) {
  const built = [];
  for (let i = 0; i < count; i++) {
    built.push(await createOrder(db, { orderedAt: minutesAgo(100 - i), ...spec }));
  }
  return built.map((b) => b.order);
}

const refs = (orders: { id: string; version: number }[]) =>
  orders.map((o) => ({ id: o.id, expectedVersion: o.version }));

const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

describe("createBatch", () => {
  it("begins picking every order for the actor, with slots in queue order", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [a, b, c, d, e, f] = await pending(6);
    // Higher priority first, then oldest: d jumps the queue.
    await db.order.update({ where: { id: d?.id }, data: { priority: 2 } });
    const orders = [f, e, d, c, b, a].map((o) => o as NonNullable<typeof o>);

    const batch = await createBatch(db, picker, { orders: refs(orders), idempotencyKey: key() });

    expect(batch.closedAt).toBeNull();
    expect(batch.owner.id).toBe(picker.userId);
    expect(batch.members.map((m) => [m.slot, m.orderId])).toEqual([
      [1, d?.id],
      [2, a?.id],
      [3, b?.id],
      [4, c?.id],
      [5, e?.id],
      [6, f?.id],
    ]);
    expect(batch.members.every((m) => m.state === "live" && m.status === "PICKING")).toBe(true);
    for (const o of orders) {
      expect(await orderRow(o.id)).toMatchObject({
        status: "PICKING",
        claimedById: picker.userId,
        version: o.version + 1,
      });
    }
    // Each move goes through workflow's transition: a stage event and an audit per order.
    expect(await db.orderStageEvent.count({ where: { toStatus: "PICKING" } })).toBe(6);
    expect(await db.auditEvent.count({ where: { action: "order.beginPicking" } })).toBe(6);
    expect(await db.auditEvent.count({ where: { action: "pickBatch.create" } })).toBe(1);
  });

  it("takes orders the actor is already picking, without moving them again", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [mine] = await pending(1, {
      status: "PICKING",
      version: 2,
      claimedById: picker.userId,
      claimedAt: minutesAgo(5),
    });
    const [fresh] = await pending(1);
    const orders = [mine, fresh].map((o) => o as NonNullable<typeof o>);

    const batch = await createBatch(db, picker, { orders: refs(orders), idempotencyKey: key() });

    expect(batch.members.map((m) => m.orderId)).toEqual([mine?.id, fresh?.id]);
    expect((await orderRow(mine?.id as string)).version).toBe(2);
    expect(await db.orderStageEvent.count()).toBe(1);
  });

  it("moves none and names the holder when someone else is picking one", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const holder = await db.user.create({
      data: { name: "Rosa", email: "rosa@example.test", roles: ["PICKER"] },
    });
    const [a, b] = await pending(2);
    const [taken] = await pending(1, { claimedById: holder.id, claimedAt: minutesAgo(1) });
    const orders = [a, b, taken].map((o) => o as NonNullable<typeof o>);

    const error = await createBatch(db, picker, {
      orders: refs(orders),
      idempotencyKey: key(),
    }).catch((e) => e);

    expect(error).toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.picking.batchFailed",
      failures: [
        {
          orderId: taken?.id,
          messageKey: "errors.workflow.claimedByOther",
          params: { name: "Rosa" },
        },
      ],
    });
    for (const o of orders) expect((await orderRow(o.id)).status).toBe("PENDING");
    expect(await db.pickBatch.count()).toBe(0);
    expect(await db.orderStageEvent.count()).toBe(0);
  });

  it("names the holder of an order someone began picking since the queue was loaded", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const holder = await db.user.create({
      data: { name: "Rosa", email: "rosa@example.test", roles: ["PICKER"] },
    });
    const [free, taken] = await pending(2);
    // Rosa began it: Picking, her claim, and a version the picker's queue hasn't seen.
    await db.order.update({
      where: { id: taken?.id },
      data: { status: "PICKING", version: 2, claimedById: holder.id, claimedAt: new Date() },
    });

    const error = await createBatch(db, picker, {
      orders: refs([free, taken].map((o) => o as NonNullable<typeof o>)),
      idempotencyKey: key(),
    }).catch((e) => e);

    expect(error.failures).toEqual([
      {
        orderId: taken?.id,
        messageKey: "errors.workflow.claimedByOther",
        params: { name: "Rosa" },
      },
    ]);
  });

  it("reports every order that can't be taken: stale, wrong status, someone else's Picking order", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const [ok, stale] = await pending(2);
    const [packing] = await pending(1, { status: "PACKING" });
    // Picking with an expired claim: nobody's, so not the actor's either.
    const [lapsed] = await pending(1, {
      status: "PICKING",
      claimedById: other.userId,
      claimedAt: minutesAgo(600),
    });
    const orders = [ok, stale, packing, lapsed].map((o) => o as NonNullable<typeof o>);
    const input = refs(orders).map((r) => (r.id === stale?.id ? { ...r, expectedVersion: 9 } : r));

    const error = await createBatch(db, picker, { orders: input, idempotencyKey: key() }).catch(
      (e) => e,
    );

    expect(
      error.failures.map((f: { orderId: string; messageKey: string }) => [f.orderId, f.messageKey]),
    ).toEqual(
      expect.arrayContaining([
        [stale?.id, "errors.workflow.stale"],
        [packing?.id, "errors.workflow.illegalTransition"],
        [lapsed?.id, "errors.picking.claimRequired"],
      ]),
    );
    expect(error.failures).toHaveLength(3);
    expect((await orderRow(ok?.id as string)).status).toBe("PENDING");
  });

  it("reports an order that doesn't exist", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [a] = await pending(1);
    const missing = "01900000-0000-7000-8000-000000000000";

    const error = await createBatch(db, picker, {
      orders: [...refs([a as NonNullable<typeof a>]), { id: missing, expectedVersion: 1 }],
      idempotencyKey: key(),
    }).catch((e) => e);

    expect(error.failures).toEqual([
      { orderId: missing, messageKey: "errors.notFound", params: {} },
    ]);
  });

  it("refuses more orders than Settings.pickBatchMaxOrders", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await updateSettings(db, admin, { pickBatchMaxOrders: 3 });
    const picker = await createActor(db, ["PICKER"]);
    const orders = await pending(4);

    await expect(
      createBatch(db, picker, { orders: refs(orders), idempotencyKey: key() }),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.picking.batchTooLarge",
      params: { max: 3 },
    });
    expect(await db.order.count({ where: { status: "PICKING" } })).toBe(0);

    // At the limit is fine.
    await createBatch(db, picker, { orders: refs(orders.slice(0, 3)), idempotencyKey: key() });
  });

  it("refuses fewer than two orders", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const orders = await pending(1);
    await expect(
      createBatch(db, picker, { orders: refs(orders), idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.validation" });
  });

  it("refuses a second open batch", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const orders = await pending(4);
    await createBatch(db, picker, { orders: refs(orders.slice(0, 2)), idempotencyKey: key() });

    await expect(
      createBatch(db, picker, { orders: refs(orders.slice(2)), idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.picking.batchOpen" });
    expect((await orderRow(orders[2]?.id as string)).status).toBe("PENDING");
  });

  it("closes an open batch with no live orders left instead of refusing", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const orders = await pending(4);
    const first = await createBatch(db, picker, {
      orders: refs(orders.slice(0, 2)),
      idempotencyKey: key(),
    });
    // Both orders moved on outside the batch (completed elsewhere).
    await db.order.updateMany({
      where: { id: { in: first.members.map((m) => m.orderId) } },
      data: { status: "PACKING" },
    });

    const second = await createBatch(db, picker, {
      orders: refs(orders.slice(2)),
      idempotencyKey: key(),
    });

    expect(second.id).not.toBe(first.id);
    expect((await db.pickBatch.findUniqueOrThrow({ where: { id: first.id } })).closedAt).not.toBe(
      null,
    );
  });

  it("is idempotent: a replay returns the same batch and moves nothing again", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const orders = await pending(2);
    const input = { orders: refs(orders), idempotencyKey: key() };

    const first = await createBatch(db, picker, input);
    const replay = await createBatch(db, picker, input);

    expect(replay).toEqual(first);
    expect(await db.pickBatch.count()).toBe(1);
    expect(await db.orderStageEvent.count()).toBe(2);
  });

  it("lets exactly one of two concurrent creates over a shared order succeed", async () => {
    await settingsRow();
    const [ana, ben] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const [shared, a, b] = await pending(3);
    const ordersA = refs([shared, a].map((o) => o as NonNullable<typeof o>));
    const ordersB = refs([b, shared].map((o) => o as NonNullable<typeof o>));

    const results = await Promise.allSettled([
      createBatch(db, ana, { orders: ordersA, idempotencyKey: key() }),
      createBatch(db, ben, { orders: ordersB, idempotencyKey: key() }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      messageKey: "errors.picking.batchFailed",
    });
    expect(await db.pickBatch.count()).toBe(1);
    expect(await db.pickBatchOrder.count({ where: { orderId: shared?.id } })).toBe(1);
  });

  it("lets one of two concurrent creates by the same picker succeed, the other is batchOpen", async () => {
    await settingsRow();
    const picker = await createActor(db, ["PICKER"]);
    const orders = await pending(4);

    const results = await Promise.allSettled([
      createBatch(db, picker, { orders: refs(orders.slice(0, 2)), idempotencyKey: key() }),
      createBatch(db, picker, { orders: refs(orders.slice(2)), idempotencyKey: key() }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({ messageKey: "errors.picking.batchOpen" });
  });

  it.each([["PACKER"], ["QA"], ["SHIPPER"]] as const)("is forbidden for %s", async (role) => {
    const actor = await createActor(db, [role]);
    const orders = await pending(2);
    await expect(
      createBatch(db, actor, { orders: refs(orders), idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await db.order.count({ where: { status: "PICKING" } })).toBe(0);
  });
});

describe("getBatch", () => {
  async function started(picker: UserActor, count = 3) {
    const orders = await pending(count);
    return createBatch(db, picker, { orders: refs(orders), idempotencyKey: key() });
  }

  it("shows each slot's order and whether it is still in the batch", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const batch = await started(picker);
    const [one, two, three] = batch.members;
    await db.order.update({ where: { id: two?.orderId }, data: { status: "PACKING" } });
    // Taken over elsewhere.
    await db.order.update({ where: { id: three?.orderId }, data: { claimedById: other.userId } });

    const read = await getBatch(db, picker, { id: batch.id });

    expect(read.members.map((m) => [m.slot, m.state, m.status])).toEqual([
      [1, "live", "PICKING"],
      [2, "left", "PACKING"],
      [3, "left", "PICKING"],
    ]);
    expect(read.members[0]?.number).toBe(one?.number);
  });

  it("closes the batch once no member is live", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await started(picker, 2);
    await db.order.updateMany({
      where: { id: { in: batch.members.map((m) => m.orderId) } },
      data: { status: "ON_HOLD" },
    });

    const read = await getBatch(db, picker, { id: batch.id });

    expect(read.closedAt).toBeInstanceOf(Date);
    // Its rows no longer hold the orders: they can join a new batch.
    expect(await db.pickBatchOrder.count({ where: { removedAt: null } })).toBe(0);
  });

  it("can be read by anyone who can read orders, and not found otherwise", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const batch = await started(picker, 2);
    const packer = await createActor(db, ["PACKER"]);

    expect((await getBatch(db, packer, { id: batch.id })).id).toBe(batch.id);
    await expect(
      getBatch(db, packer, { id: "01900000-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("myPicks", () => {
  it("returns my open batch and my other live-claimed Picking orders", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const batch = await createBatch(db, picker, {
      orders: refs(await pending(2)),
      idempotencyKey: key(),
    });
    const [solo] = await pending(1, {
      status: "PICKING",
      claimedById: picker.userId,
      claimedAt: minutesAgo(1),
    });
    await pending(1, { status: "PICKING", claimedById: picker.userId, claimedAt: minutesAgo(600) });
    await pending(1, { status: "PICKING", claimedById: other.userId, claimedAt: minutesAgo(1) });
    await pending(1, { status: "PACKING", claimedById: picker.userId, claimedAt: minutesAgo(1) });

    const picks = await myPicks(db, picker);

    expect(picks.batch?.id).toBe(batch.id);
    expect(picks.orders.map((o) => o.id)).toEqual([solo?.id]);
  });

  it("returns nothing for someone with no picks", async () => {
    const picker = await createActor(db, ["PICKER"]);
    expect(await myPicks(db, picker)).toEqual({ batch: null, orders: [] });
  });

  it("is forbidden for the system actor", async () => {
    await expect(myPicks(db, systemActor)).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});
