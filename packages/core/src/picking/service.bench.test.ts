import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { pickLine, unpickLine } from "./service";

/**
 * SC 14 / NFR-PERF-02: a tap is confirmed by the server in under 300 ms at p95. The order has ten
 * lines, some with voids, a large order for this store; taps alternate pick and unpick
 * across its lines so every run does a real write.
 */

const db: Db = testDb();
const RUNS = 60;
let picker: UserActor;
let itemIds: string[];

beforeAll(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
  const { items } = await createOrder(db, {
    status: "PICKING",
    claimedById: picker.userId,
    lines: Array.from({ length: 10 }, (_, i) => ({
      quantity: 3,
      bin: `A${i}`,
      voids: i % 4 === 0 ? [{ quantity: 1 }] : [],
    })),
  });
  itemIds = items.map((i) => i.id);
});
afterAll(() => db.$disconnect());

describe("pick write timing", () => {
  it("confirms a tap under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const itemId = itemIds[run % itemIds.length] as string;
      const write = Math.floor(run / itemIds.length) % 2 === 0 ? pickLine : unpickLine;
      const start = performance.now();
      await write(db, picker, { itemId });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(RUNS * 0.95) - 1]).toBeLessThan(300);
  });
});
