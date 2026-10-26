import type { Db, FulfillmentStage, WorkflowStatus } from "@woolrus/db";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { Actor } from "../permissions";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { completePicking } from "../workflow/service";
import { stageFor } from "./stage";
import { undoVoid, voidItem } from "./voids";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const reason = "Out of stock";
const voidRows = (orderItemId: string) => db.itemVoid.findMany({ where: { orderItemId } });
const open = async (orderItemId: string) =>
  (await voidRows(orderItemId)).filter((v) => !v.undoneAt).reduce((n, v) => n + v.quantity, 0);

/** An order with one line of `quantity`, and a picker with no claim on it. */
async function setup(
  quantity = 3,
  spec: Parameters<typeof createOrder>[1] = {},
  roles: Actor["roles"] = ["PICKER"],
) {
  const actor = await createActor(db, roles);
  const built = await createOrder(db, { lines: [{ quantity }], ...spec });
  const line = built.items[0]?.id as string;
  return { actor, ...built, line, input: { orderId: built.order.id, orderItemId: line } };
}

describe("stageFor", () => {
  it("maps each status to the stage it is in, and a held order to the one it was held from", () => {
    const cases: [WorkflowStatus, FulfillmentStage][] = [
      ["PENDING", "INTAKE"],
      ["PICKING", "PICKING"],
      ["PACKING", "PACKING"],
      ["QA", "QA"],
      ["READY", "SHIPPING"],
      ["COMPLETED", "CUSTOMER"],
    ];
    for (const [status, stage] of cases) {
      expect(stageFor({ status, heldFromStatus: null })).toBe(stage);
    }
    expect(stageFor({ status: "ON_HOLD", heldFromStatus: "PACKING" })).toBe("PACKING");
    expect(stageFor({ status: "ON_HOLD", heldFromStatus: null })).toBe("INTAKE");
  });
});

describe("voidItem", () => {
  it("voids part of a line, recording the order's stage, who, and why", async () => {
    const { actor, order, line, input } = await setup(3, { status: "PICKING" });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason: `  ${reason} ` });

    expect(result.line).toMatchObject({ id: line, quantity: 3, activeQuantity: 2 });
    expect(result.void).toMatchObject({ quantity: 1, reason, stage: "PICKING", undoneAt: null });
    const [row] = await voidRows(line);
    expect(row).toMatchObject({ orderId: order.id, voidedById: actor.userId, stage: "PICKING" });
  });

  it("voids the rest of a line, then refuses another", async () => {
    const { actor, line, input } = await setup(3);
    await voidItem(db, actor, { ...input, quantity: 1, reason });

    const second = await voidItem(db, actor, { ...input, quantity: 2, reason });
    expect(second.line.activeQuantity).toBe(0);

    await expect(voidItem(db, actor, { ...input, quantity: 1, reason })).rejects.toMatchObject({
      messageKey: "errors.voids.quantity",
    });
    expect(await open(line)).toBe(3);
  });

  it.each([
    ["zero", { quantity: 0 }],
    ["negative", { quantity: -1 }],
    ["above the active quantity", { quantity: 4 }],
    ["a fraction", { quantity: 1.5 }],
  ])("refuses a quantity that is %s and changes nothing", async (_name, { quantity }) => {
    const { actor, line, input } = await setup(3);

    await expect(voidItem(db, actor, { ...input, quantity, reason })).rejects.toMatchObject({
      messageKey: "errors.voids.quantity",
    });

    expect(await voidRows(line)).toEqual([]);
    expect(await db.auditEvent.count({ where: { action: "void.create" } })).toBe(0);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["over 500 characters", "x".repeat(501)],
  ])("refuses a reason that is %s", async (_name, bad) => {
    const { actor, line, input } = await setup(3);

    await expect(voidItem(db, actor, { ...input, quantity: 1, reason: bad })).rejects.toMatchObject(
      { kind: "BAD_REQUEST", fields: { reason: expect.any(String) } },
    );

    expect(await voidRows(line)).toEqual([]);
  });

  it("refuses a line that belongs to another order", async () => {
    const { actor, order } = await setup(3);
    const other = await createOrder(db, { lines: [{ quantity: 2 }] });

    await expect(
      voidItem(db, actor, {
        orderId: order.id,
        orderItemId: other.items[0]?.id as string,
        quantity: 1,
        reason,
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });

    expect(await db.itemVoid.count()).toBe(0);
  });

  it("refuses a missing order", async () => {
    const { actor, line } = await setup(3);
    await expect(
      voidItem(db, actor, {
        orderId: crypto.randomUUID(),
        orderItemId: line,
        quantity: 1,
        reason,
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it.each(["COMPLETED", "CANCELLED"] as const)("refuses a %s order", async (status) => {
    const { actor, line, input } = await setup(3, { status });

    await expect(voidItem(db, actor, { ...input, quantity: 1, reason })).rejects.toMatchObject({
      messageKey: "errors.voids.orderClosed",
    });
    expect(await voidRows(line)).toEqual([]);
  });

  it("refuses an order with a live label, and allows one whose labels are voided", async () => {
    const live = await setup(3, {
      status: "READY",
      lines: [{ quantity: 3 }],
      packages: [{ items: [{ line: 0, quantity: 3 }], label: "ACTIVE" }],
    });
    await expect(
      voidItem(db, live.actor, { ...live.input, quantity: 1, reason }),
    ).rejects.toMatchObject({ messageKey: "errors.voids.liveLabels" });
    expect(await voidRows(live.line)).toEqual([]);

    const dead = await setup(3, {
      status: "READY",
      lines: [{ quantity: 3 }],
      packages: [{ items: [{ line: 0, quantity: 3 }], label: "VOIDED" }],
    });
    const result = await voidItem(db, dead.actor, { ...dead.input, quantity: 1, reason });
    expect(result.line.activeQuantity).toBe(2);
  });

  it.each([
    ["PENDING", "INTAKE"],
    ["PICKING", "PICKING"],
    ["PACKING", "PACKING"],
    ["QA", "QA"],
    ["READY", "SHIPPING"],
  ] as const)("allows voiding from %s, with no claim, recording %s", async (status, stage) => {
    const { actor, input } = await setup(2, { status });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason });

    expect(result.void.stage).toBe(stage);
  });

  it("allows voiding a held order, recording the stage it was held from", async () => {
    const { actor, input } = await setup(2, {
      status: "ON_HOLD",
      heldFromStatus: "PACKING",
      holdReason: "Waiting",
    });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason });

    expect(result.void.stage).toBe("PACKING");
  });

  it("lets every role void, and refuses someone with no role", async () => {
    for (const role of ["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      const { actor, line, input } = await setup(2, {}, [role]);
      await voidItem(db, actor, { ...input, quantity: 1, reason });
      expect(await open(line)).toBe(1);
    }

    const { line, input } = await setup(2);
    const nobody = await createActor(db, []);
    await expect(voidItem(db, nobody, { ...input, quantity: 1, reason })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await voidRows(line)).toEqual([]);
  });

  it("voids a non-physical line", async () => {
    const { actor, order } = await setup(1, { lines: [{ quantity: 1, physical: false }] });
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

    const result = await voidItem(db, actor, {
      orderId: order.id,
      orderItemId: item.id,
      quantity: 1,
      reason,
    });

    expect(result.line.activeQuantity).toBe(0);
  });

  it("refreshes the claim of a holder who voids", async () => {
    const holder = await createActor(db, ["PICKER"]);
    const old = new Date(Date.now() - 60_000);
    const { order, items } = await createOrder(db, {
      status: "PICKING",
      claimedById: holder.userId,
      claimedAt: old,
      lines: [{ quantity: 2 }],
    });

    await voidItem(db, holder, {
      orderId: order.id,
      orderItemId: items[0]?.id as string,
      quantity: 1,
      reason,
    });

    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.claimedAt?.getTime()).toBeGreaterThan(old.getTime());
  });

  it("returns how many units of the line are in packages", async () => {
    const { actor, input } = await setup(3, {
      status: "PACKING",
      lines: [{ quantity: 3 }],
      packages: [{ items: [{ line: 0, quantity: 2 }] }],
    });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason });

    expect(result.line.packedQuantity).toBe(2);
  });

  describe("recording", () => {
    let listener: pg.Client;
    let received: unknown[];
    beforeEach(async () => {
      received = [];
      listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await listener.connect();
      listener.on("notification", (msg) => received.push(JSON.parse(msg.payload ?? "null")));
      await listener.query(`LISTEN ${ORDER_CHANGED_CHANNEL}`);
    });
    afterEach(() => listener.end());

    it("audits with before and after, emits order_changed, and leaves the version alone", async () => {
      const { actor, order, line, input } = await setup(3, { status: "PICKING", version: 4 });

      const { void: made } = await voidItem(db, actor, { ...input, quantity: 2, reason });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const events = await db.auditEvent.findMany({ where: { action: "void.create" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        entityType: "ItemVoid",
        entityId: made.id,
        actorId: actor.userId,
      });
      expect(events[0]?.before).toMatchObject({ orderItemId: line, activeQuantity: 3 });
      expect(events[0]?.after).toMatchObject({ quantity: 2, reason, activeQuantity: 1 });
      expect(received).toEqual([{ id: order.id, status: "PICKING" }]);
      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.version).toBe(4);
    });

    it("records nothing and sends nothing when the void is refused", async () => {
      const { actor, input } = await setup(1);
      await expect(voidItem(db, actor, { ...input, quantity: 2, reason })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(await db.auditEvent.count({ where: { action: "void.create" } })).toBe(0);
      expect(received).toEqual([]);
    });
  });
});

describe("pick reconcile through voidItem and undoVoid", () => {
  it("turns an out-of-stock line PICKED when its missing units are voided, and back on undo", async () => {
    const { actor, line, input } = await setup(3, {
      status: "PICKING",
      lines: [{ quantity: 3, pickStatus: "OUT_OF_STOCK", pickedQuantity: 2 }],
    });

    const voided = await voidItem(db, actor, { ...input, quantity: 1, reason });
    expect(voided.line).toMatchObject({ pickStatus: "PICKED", activeQuantity: 2 });
    expect(await db.orderItem.findUniqueOrThrow({ where: { id: line } })).toMatchObject({
      pickStatus: "PICKED",
      pickedQuantity: 2,
    });

    const undone = await undoVoid(db, actor, { voidId: voided.void.id });
    expect(undone.line).toMatchObject({ pickStatus: "PENDING", activeQuantity: 3 });
  });

  it("lets the picker finish once the missing units are voided", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order, items } = await createOrder(db, {
      status: "PICKING",
      version: 2,
      claimedById: picker.userId,
      lines: [{ quantity: 3, pickStatus: "OUT_OF_STOCK", pickedQuantity: 2 }],
    });
    await expect(
      completePicking(db, picker, { orderId: order.id, expectedVersion: 2 }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });

    await voidItem(db, picker, {
      orderId: order.id,
      orderItemId: items[0]?.id as string,
      quantity: 1,
      reason,
    });

    const done = await completePicking(db, picker, { orderId: order.id, expectedVersion: 2 });
    expect(done.status).toBe("PACKING");
  });

  it("caps a picked line's count at the new active quantity", async () => {
    const { actor, input } = await setup(3, {
      status: "PICKING",
      lines: [{ quantity: 3, pickStatus: "PICKED", pickedQuantity: 3 }],
    });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason });

    expect(result.line).toMatchObject({ pickStatus: "PICKED", activeQuantity: 2 });
    expect(await db.orderItem.findFirstOrThrow({ where: { id: input.orderItemId } })).toMatchObject(
      { pickedQuantity: 2 },
    );
  });

  it("leaves a pending line with nothing picked pending, even when all of it is voided", async () => {
    const { actor, input } = await setup(2, { status: "PICKING" });

    const result = await voidItem(db, actor, { ...input, quantity: 2, reason });

    expect(result.line).toMatchObject({ pickStatus: "PENDING", activeQuantity: 0 });
  });

  it("makes a pending line whose picked units now cover it PICKED", async () => {
    const { actor, input } = await setup(3, {
      status: "PICKING",
      lines: [{ quantity: 3, pickStatus: "PENDING", pickedQuantity: 2 }],
    });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason });

    expect(result.line.pickStatus).toBe("PICKED");
  });

  it("keeps a substituted line substituted at the new quantity", async () => {
    const { actor, input } = await setup(3, {
      status: "PICKING",
      lines: [{ quantity: 3, pickStatus: "SUBSTITUTED", pickedQuantity: 3 }],
    });

    const result = await voidItem(db, actor, { ...input, quantity: 1, reason });

    expect(result.line.pickStatus).toBe("SUBSTITUTED");
  });
});

describe("priority", () => {
  const rush = async () =>
    db.priorityRule.create({
      data: {
        name: "Rush",
        position: 1,
        priority: 2,
        condition: { type: "lineItem", match: "name", value: "Rush Order" },
      },
    });

  it("drops an order out of Urgent when its Rush Order line is voided, and restores it on undo", async () => {
    await rush();
    const actor = await createActor(db, ["PACKER"]);
    const { order, items } = await createOrder(db, {
      priority: 2,
      lines: [{ quantity: 1 }, { quantity: 1, name: "Rush Order", physical: false }],
    });
    const priority = async () =>
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).priority;

    const { void: made } = await voidItem(db, actor, {
      orderId: order.id,
      orderItemId: items[1]?.id as string,
      quantity: 1,
      reason: "Customer request",
    });
    expect(await priority()).toBe(0);

    await undoVoid(db, actor, { voidId: made.id });
    expect(await priority()).toBe(2);
  });
});

describe("undoVoid", () => {
  it("makes the line whole again and records the undo", async () => {
    const { actor, order, line, input } = await setup(3, { status: "PICKING", version: 3 });
    const { void: made } = await voidItem(db, actor, { ...input, quantity: 2, reason });
    const other = await createActor(db, ["PACKER"]);

    const result = await undoVoid(db, other, { voidId: made.id });

    expect(result.line).toMatchObject({ id: line, activeQuantity: 3 });
    expect(result.void.undoneAt).toBeInstanceOf(Date);
    expect(await db.itemVoid.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({
      undoneById: other.userId,
    });
    const [event] = await db.auditEvent.findMany({ where: { action: "void.undo" } });
    expect(event).toMatchObject({ entityId: made.id, actorId: other.userId });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(3);
  });

  it("refuses a void that was already undone", async () => {
    const { actor, input } = await setup(3);
    const { void: made } = await voidItem(db, actor, { ...input, quantity: 1, reason });
    await undoVoid(db, actor, { voidId: made.id });

    await expect(undoVoid(db, actor, { voidId: made.id })).rejects.toMatchObject({
      messageKey: "errors.voids.alreadyUndone",
    });
  });

  it("refuses a void an admin already resolved", async () => {
    const { actor, input, line } = await setup(3);
    const { void: made } = await voidItem(db, actor, { ...input, quantity: 1, reason });
    await db.itemVoid.update({
      where: { id: made.id },
      data: { resolvedAt: new Date(), resolution: "HANDLED_MANUALLY", resolutionNotes: "Done" },
    });

    await expect(undoVoid(db, actor, { voidId: made.id })).rejects.toMatchObject({
      messageKey: "errors.voids.alreadyResolved",
    });
    expect(await open(line)).toBe(1);
  });

  it("refuses an unknown void", async () => {
    const { actor } = await setup(3);
    await expect(undoVoid(db, actor, { voidId: crypto.randomUUID() })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it.each(["COMPLETED", "CANCELLED"] as const)("refuses once the order is %s", async (status) => {
    const { actor, order, input } = await setup(3);
    const { void: made } = await voidItem(db, actor, { ...input, quantity: 1, reason });
    await db.order.update({ where: { id: order.id }, data: { status } });

    await expect(undoVoid(db, actor, { voidId: made.id })).rejects.toMatchObject({
      messageKey: "errors.voids.orderClosed",
    });
  });

  it("refuses while the order has a live label", async () => {
    const { actor, input, order } = await setup(3, {
      status: "READY",
      lines: [{ quantity: 3 }],
      packages: [{ items: [{ line: 0, quantity: 2 }] }],
    });
    const { void: made } = await voidItem(db, actor, { ...input, quantity: 1, reason });
    const pkg = await db.package.findFirstOrThrow({ where: { orderId: order.id } });
    await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: "ACTIVE",
        idempotencyKey: crypto.randomUUID(),
        carrierCode: "usps",
        serviceCode: "ground",
        currency: "USD",
      },
    });

    await expect(undoVoid(db, actor, { voidId: made.id })).rejects.toMatchObject({
      messageKey: "errors.voids.liveLabels",
    });
  });

  it("refuses someone with no role, and leaves the void open", async () => {
    const { actor, input, line } = await setup(3);
    const { void: made } = await voidItem(db, actor, { ...input, quantity: 1, reason });
    const nobody = await createActor(db, []);

    await expect(undoVoid(db, nobody, { voidId: made.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await open(line)).toBe(1);
  });
});

describe("concurrency", () => {
  it("never over-voids a line when two people void its last units at once", async () => {
    for (const [each, wins] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const { actor, line, input } = await setup(2);
      const other = await createActor(db, ["PACKER"]);

      const results = await Promise.allSettled([
        voidItem(db, actor, { ...input, quantity: each, reason }),
        voidItem(db, other, { ...input, quantity: each, reason }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(wins);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toMatchObject({ messageKey: "errors.voids.quantity" });
        }
      }
      expect(await open(line)).toBeLessThanOrEqual(2);
    }
  });

  it("serialises a void with completePicking: either it lands first and the gate sees it, or after", async () => {
    for (let round = 0; round < 3; round += 1) {
      const picker = await createActor(db, ["PICKER"]);
      const { order, items } = await createOrder(db, {
        status: "PICKING",
        version: 2,
        claimedById: picker.userId,
        lines: [{ quantity: 3, pickStatus: "OUT_OF_STOCK", pickedQuantity: 2 }],
      });
      const orderItemId = items[0]?.id as string;

      const [voided, completed] = await Promise.allSettled([
        voidItem(db, picker, { orderId: order.id, orderItemId, quantity: 1, reason }),
        completePicking(db, picker, { orderId: order.id, expectedVersion: 2 }),
      ]);

      expect(voided.status).toBe("fulfilled");
      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      const line = await db.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
      // Moved on only if the void was already visible to the gate; never half of each.
      expect(after.status).toBe(completed.status === "fulfilled" ? "PACKING" : "PICKING");
      expect(line).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 2 });
    }
  });
});
