import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { addPackage, getPackView, packUnits, unpackUnits } from "./service";

/**
 * SPEC-packing criterion 15 / NFR-PERF-02: a tap is confirmed by the server in under 300 ms at
 * p95, and the pack view of 30 lines over 5 packages loads in under 300 ms at p95. Taps alternate
 * pack and unpack across the lines so every run does a real write.
 */

const db: Db = testDb();
const RUNS = 60;
let packer: UserActor;
let orderId: string;
let packageIds: string[];
let itemIds: string[];

const p95 = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];

beforeAll(async () => {
  await resetDb(db);
  packer = await createActor(db, ["PACKER"]);
  const { order, items } = await createOrder(db, {
    status: "PACKING",
    claimedById: packer.userId,
    lines: Array.from({ length: 30 }, (_, i) => ({
      quantity: 3,
      pickStatus: "PICKED" as const,
      bin: `A${i}`,
      voids: i % 4 === 0 ? [{ quantity: 1 }] : [],
    })),
  });
  orderId = order.id;
  itemIds = items.map((i) => i.id);
  const box = await db.box.create({
    data: { name: "Bench", lengthIn: 12, widthIn: 12, heightIn: 12 },
  });
  let last = await addPackage(db, packer, {
    orderId,
    box: { boxId: box.id },
    idempotencyKey: crypto.randomUUID(),
  });
  for (let i = 1; i < 5; i += 1) {
    last = await addPackage(db, packer, {
      orderId,
      box: { boxId: box.id },
      idempotencyKey: crypto.randomUUID(),
    });
  }
  packageIds = last.packages.map((p) => p.id);
  // Spread some units over the packages so the view has contents to read.
  for (const [i, orderItemId] of itemIds.entries()) {
    await packUnits(db, packer, { packageId: packageIds[i % 5] as string, orderItemId });
  }
});
afterAll(() => db.$disconnect());

describe("packing timing", () => {
  it("confirms a pack or unpack under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const i = run % itemIds.length;
      const input = { packageId: packageIds[i % 5] as string, orderItemId: itemIds[i] as string };
      const write = Math.floor(run / itemIds.length) % 2 === 0 ? unpackUnits : packUnits;
      const start = performance.now();
      await write(db, packer, input);
      times.push(performance.now() - start);
    }
    expect(p95(times)).toBeLessThan(300);
  });

  it("loads the pack view of 30 lines over 5 packages under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < 30; run += 1) {
      const start = performance.now();
      await getPackView(db, packer, { orderId });
      times.push(performance.now() - start);
    }
    expect(p95(times)).toBeLessThan(300);
  });
});
