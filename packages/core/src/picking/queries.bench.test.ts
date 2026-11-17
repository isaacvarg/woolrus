import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import type { UserActor } from "../permissions";
import { getBatchSuggestions } from "./queries";

/**
 * SPEC-picking A1, criterion 20: suggestions over a full day's queue, 200 Pending orders of five
 * lines, read in under 300 ms at p95. Lines draw from twenty shared products, so grouping does work.
 */

const db: Db = testDb();
const RUNS = 30;
let picker: UserActor;

beforeAll(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
  const catalog = await createOrder(db, {
    lines: Array.from({ length: 20 }, () => ({ variation: {} })),
  });
  for (let n = 0; n < 200; n += 1) {
    const lines: LineSpec[] = Array.from({ length: 5 }, (_, i) => ({
      sameAs: catalog.items[(n * 7 + i * 3) % 20] as never,
      quantity: 1 + (i % 3),
    }));
    await createOrder(db, { lines, orderedAt: new Date(Date.now() - (300 - n) * 60_000) });
  }
}, 120_000);
afterAll(() => db.$disconnect());

describe("suggestions timing", () => {
  it("reads 200 Pending orders of five lines under 300 ms at p95", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      const { suggestions } = await getBatchSuggestions(db, picker);
      times.push(performance.now() - start);
      expect(suggestions).toHaveLength(3);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(RUNS * 0.95) - 1]).toBeLessThan(300);
  });
});
