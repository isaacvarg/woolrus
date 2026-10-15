import type { Db } from "@woolrus/db";
import { seedDemoOrders } from "@woolrus/db/demo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { Actor } from "../permissions";
import { evaluateGate, loadGateSnapshot } from "./gates";
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
});
