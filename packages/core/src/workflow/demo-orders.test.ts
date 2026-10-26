import type { Db } from "@woolrus/db";
import { seedDemoOrders } from "@woolrus/db/demo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { Actor } from "../permissions";
import { evaluateGate, loadGateSnapshot } from "./gates";
import { recomputePriorities } from "./priority-rules";
import { getOrder, getOrderHistory, listQueue, queueCounts } from "./queries";

// The dev seed (T12) has to describe orders the workflow accepts, or the demo stack lies.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let admin: Actor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
});

describe("seedDemoOrders", () => {
  it("adds about 30 orders across every status, and re-running adds nothing", async () => {
    expect(await seedDemoOrders(db)).toBeGreaterThanOrEqual(25);

    const counts = await queueCounts(db, admin);
    for (const stage of Object.keys(counts) as (keyof typeof counts)[]) {
      expect(counts[stage], stage).toBeGreaterThan(0);
    }
    expect(await db.order.count({ where: { status: "COMPLETED" } })).toBeGreaterThan(0);
    expect(await db.order.count({ where: { status: "CANCELLED" } })).toBeGreaterThan(0);

    const before = {
      orders: await db.order.count(),
      items: await db.orderItem.count(),
      products: await db.product.count(),
      events: await db.orderStageEvent.count(),
    };
    expect(await seedDemoOrders(db)).toBe(0);
    expect({
      orders: await db.order.count(),
      items: await db.orderItem.count(),
      products: await db.product.count(),
      events: await db.orderStageEvent.count(),
    }).toEqual(before);
  });

  it("gives products dimensions, all but one, and a Packing order whose line of 6 needs two boxes", async () => {
    await seedDemoOrders(db);

    const physical = await db.product.findMany({ where: { physical: true } });
    expect(physical.filter((p) => p.lengthIn === null)).toHaveLength(1);
    expect(physical.every((p) => p.weightOz !== null)).toBe(true);
    const packing = await db.order.findMany({
      where: { status: "PACKING", packages: { none: {} } },
      include: { items: true },
    });
    expect(packing.some((o) => o.items.some((i) => i.quantity === 6))).toBe(true);
  });

  it("gives some products barcodes to scan", async () => {
    await seedDemoOrders(db);

    expect(await db.product.count({ where: { barcode: { not: null } } })).toBeGreaterThan(2);
  });

  it("puts a non-physical Rush Order line on an Urgent order, at the top of Pending", async () => {
    await seedDemoOrders(db);

    const [top] = (await listQueue(db, admin, { stage: "PENDING" })).rows;
    expect(top?.priority).toBe(2);
    const view = await getOrder(db, admin, { id: top?.id ?? "" });
    expect(view.lines.find((l) => l.name === "Rush Order")).toMatchObject({ physical: false });
  });

  it("includes an Express order, an old order and a held order with a reason", async () => {
    await seedDemoOrders(db);

    expect(
      await db.order.count({ where: { shippingMethod: { contains: "Express" }, priority: 1 } }),
    ).toBeGreaterThan(0);
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    expect(await db.order.count({ where: { orderedAt: { lt: twoDaysAgo } } })).toBeGreaterThan(0);
    const held = await db.order.findFirstOrThrow({ where: { status: "ON_HOLD" } });
    expect(held.holdReason).toBeTruthy();
    expect(held.heldFromStatus).not.toBeNull();
  });

  it("adds the priority rules that compute the priorities it seeded, once", async () => {
    const now = new Date();
    await seedDemoOrders(db, { now });

    const rules = await db.priorityRule.findMany({ orderBy: { position: "asc" } });
    expect(rules.map((r) => [r.name, r.priority, r.enabled])).toEqual([
      ["Rush Order", 2, true],
      ["Express shipping", 1, true],
      ["Waiting 2+ days", 1, true],
    ]);
    expect(await db.$transaction((tx) => recomputePriorities(tx, { now }))).toEqual({
      updated: 0,
    });

    await seedDemoOrders(db, { now });
    expect(await db.priorityRule.count()).toBe(rules.length);
  });

  it("gives every order a history ending in its current status", async () => {
    await seedDemoOrders(db);

    for (const order of await db.order.findMany()) {
      const [latest] = await getOrderHistory(db, admin, { id: order.id });
      expect(latest?.toStatus, order.number).toBe(order.status);
      expect(latest?.at.getTime(), order.number).toBe(order.statusChangedAt.getTime());
    }
  });

  it("leaves some orders in each stage ready to complete and some not, so gates can be demoed", async () => {
    await seedDemoOrders(db);

    const gateFor = { PICKING: "picked", PACKING: "packed", QA: "verified", READY: "shippable" };
    for (const [status, gate] of Object.entries(gateFor) as [keyof typeof gateFor, never][]) {
      const results = await Promise.all(
        (await db.order.findMany({ where: { status } })).map(async (o) =>
          evaluateGate(gate, await loadGateSnapshot(db, o.id)),
        ),
      );
      expect(
        results.some((unmet) => unmet.length === 0),
        `${status} has a ready order`,
      ).toBe(true);
      if (status !== "READY") {
        expect(
          results.some((unmet) => unmet.length > 0),
          `${status} has a blocked order`,
        ).toBe(true);
      }
    }
  });

  it("subtracts a void from a line's active quantity", async () => {
    await seedDemoOrders(db);
    const voided = await db.itemVoid.findFirstOrThrow();

    const view = await getOrder(db, admin, { id: voided.orderId });
    const line = view.lines.find((l) => l.id === voided.orderItemId);
    expect(line && line.quantity - line.activeQuantity).toBe(voided.quantity);
  });

  it("seeds the exceptions dev data: voids and issues in each state", async () => {
    await seedDemoOrders(db);

    const voids = await db.itemVoid.findMany({ include: { orderItem: true } });
    // A partial void (1 of 3), a fully voided order, and a resolved void.
    expect(voids.some((v) => !v.resolvedAt && v.quantity === 1 && v.orderItem.quantity === 3)).toBe(
      true,
    );
    expect(voids.some((v) => v.resolvedAt && v.resolution)).toBe(true);
    const fully = await db.order.findFirstOrThrow({ where: { customerName: "Gonzalo Pardo" } });
    expect(await getOrder(db, admin, { id: fully.id })).toMatchObject({ allVoided: true });

    const critical = await db.qualityIssue.findFirstOrThrow({
      where: { severity: "CRITICAL", status: "OPEN" },
      include: { notes: true },
    });
    expect(critical.notes).toHaveLength(1);
    const customer = await db.qualityIssue.findFirstOrThrow({
      where: { customerReported: true },
      include: { order: true },
    });
    expect(customer.order.status).toBe("COMPLETED");
    expect(await db.qualityIssue.count({ where: { status: "RESOLVED" } })).toBeGreaterThan(0);
  });
});
