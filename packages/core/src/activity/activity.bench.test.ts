import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { getOrderActivity } from "./timeline";

/**
 * SPEC-order-activity criterion 9: `orders.activity` for an order with 500 audit rows answers in
 * under 300 ms. Measured at p95 over repeated reads, with the visibility setting in force.
 */

const db: Db = testDb();
const RUNS = 20;
const ROWS = 500;
let packer: UserActor;
let orderId: string;

const p95 = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];

beforeAll(async () => {
  await resetDb(db);
  packer = await createActor(db, ["PACKER"]);
  const { order, items, packages } = await createOrder(db, {
    status: "PACKING",
    lines: Array.from({ length: 10 }, (_, i) => ({ quantity: 5, sku: `bench-sku-${i}` })),
    packages: [{ items: [] }],
  });
  orderId = order.id;
  const start = Date.now() - ROWS * 60_000;
  await db.orderStageEvent.createMany({
    data: [
      { orderId, toStatus: "PENDING", at: new Date(start - 120_000) },
      { orderId, fromStatus: "PENDING", toStatus: "PICKING", at: new Date(start - 60_000) },
      { orderId, fromStatus: "PICKING", toStatus: "PACKING", at: new Date(start) },
    ],
  });
  // A mix of grouping and non-grouping actions, on lines and the box, with details to clean.
  await db.auditEvent.createMany({
    data: Array.from({ length: ROWS }, (_, i) => {
      const line = items[i % items.length];
      const box = packages[0];
      return i % 3 === 0
        ? {
            actorId: packer.userId,
            entityType: "Package",
            entityId: box?.id ?? orderId,
            orderId,
            action: "package.setWeight",
            before: { weightOz: i },
            after: { weightOz: i + 1 },
            at: new Date(start + i * 60_000),
          }
        : {
            actorId: packer.userId,
            entityType: "OrderItem",
            entityId: line?.id ?? orderId,
            orderId,
            action: "pick.pickLine",
            before: { pickedQuantity: 0 },
            after: { pickedQuantity: 1 },
            at: new Date(start + i * 60_000),
          };
    }),
  });
});
afterAll(() => db.$disconnect());

describe("orders.activity timing", () => {
  it("answers for an order with 500 audit rows under 300 ms at p95", async () => {
    await getOrderActivity(db, packer, { id: orderId }); // warm the connection and plans
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const begin = performance.now();
      const feed = await getOrderActivity(db, packer, { id: orderId });
      times.push(performance.now() - begin);
      expect(feed.truncated).toBe(false);
    }
    expect(p95(times)).toBeLessThan(300);
  }, 60_000);
});
