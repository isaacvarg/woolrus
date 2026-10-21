import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import type { UserActor } from "../permissions";
import { createBatch, getBatch } from "./batches";

/**
 * SC 14: the batch list for a full cart, ten orders of ten lines, reads in under 300 ms at p95.
 * Half of each order's lines share products with the other orders, so grouping does real work.
 */

const db: Db = testDb();
const RUNS = 40;
let picker: UserActor;
let batchId: string;

beforeAll(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
  const first = await createOrder(db, {
    lines: Array.from({ length: 10 }, (_, i) => ({ quantity: 2, bin: `A${i}`, variation: {} })),
  });
  const orders = [first.order];
  for (let n = 1; n < 10; n += 1) {
    const lines: LineSpec[] = first.items.map((item, i) =>
      i % 2 === 0 ? { sameAs: item, quantity: n } : { quantity: 1, bin: `B${n}${i}` },
    );
    orders.push((await createOrder(db, { lines })).order);
  }
  const batch = await createBatch(db, picker, {
    orders: orders.map((o) => ({ id: o.id, expectedVersion: o.version })),
    idempotencyKey: "batch-bench",
  });
  batchId = batch.id;
});
afterAll(() => db.$disconnect());

describe("batch list timing", () => {
  it("reads ten orders of ten lines under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      const batch = await getBatch(db, picker, { id: batchId });
      times.push(performance.now() - start);
      expect(batch.groups.flatMap((g) => g.chips)).toHaveLength(100);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(RUNS * 0.95) - 1]).toBeLessThan(300);
  });
});
