import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { reportIssue } from "./issues";
import { undoVoid, voidItem } from "./voids";

/**
 * SPEC-exceptions criterion 17: `voids.void` and `issues.report` confirm in under 300 ms at p95.
 * Voids alternate with undos across the lines so every run does a real write.
 */

const db: Db = testDb();
const RUNS = 40;
let admin: UserActor;
let orderId: string;
let itemIds: string[];

const p95 = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];

beforeAll(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
  const { order, items } = await createOrder(db, {
    status: "PICKING",
    lines: Array.from({ length: 20 }, (_, i) => ({
      quantity: 5,
      pickStatus: "PICKED" as const,
      sku: `bench-sku-${i}`,
    })),
  });
  orderId = order.id;
  itemIds = items.map((i) => i.id);
});
afterAll(() => db.$disconnect());

describe("exceptions timing", () => {
  it("voids a line under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const orderItemId = itemIds[run % itemIds.length] as string;
      const start = performance.now();
      const { void: created } = await voidItem(db, admin, {
        orderId,
        orderItemId,
        quantity: 1,
        reason: "Out of stock",
      });
      times.push(performance.now() - start);
      await undoVoid(db, admin, { voidId: created.id });
    }
    expect(p95(times)).toBeLessThan(300);
  }, 30_000);

  it("reports an issue under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      await reportIssue(db, admin, {
        orderId,
        orderItemId: itemIds[run % itemIds.length] as string,
        type: "DAMAGED_ITEM",
        severity: "MINOR",
        description: `Dented lid ${run}`,
      });
      times.push(performance.now() - start);
    }
    expect(p95(times)).toBeLessThan(300);
  }, 30_000);
});
