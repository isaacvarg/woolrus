import type { Db } from "@woolrus/db";
import { seedReportingHistory } from "@woolrus/db/demo-reporting";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { Actor } from "../permissions";
import { cycleTime } from "./cycle-time";
import { quality } from "./quality";
import { throughput, throughputCsv } from "./throughput";
import { reportsToday } from "./today";

/**
 * SPEC-reporting criterion 8: on 10,000 orders over 90 days (with their events, items and issues),
 * each report read answers in under 1 s and a 90-day throughput CSV streams in under 5 s. The data
 * is the dev seed's history generator at volume: every order shipped, with picks, packs, QA,
 * audit rows, issues, blocked scans, holds, repacks and voids. Measured as the slowest of the
 * warm runs, with the first run left out (connection and plans).
 */

const db: Db = testDb();
const ORDERS = 10_000;
const DAYS = 90;
const RUNS = 4;
const now = new Date("2026-11-18T21:00:00Z");
const timeZone = "America/Chicago";
const range = { from: "2026-08-21", to: "2026-11-18", timeZone };
let admin: Actor;

beforeAll(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
  expect(await seedReportingHistory(db, { now, orders: ORDERS, days: DAYS })).toBe(ORDERS);
  await db.$executeRawUnsafe("ANALYZE");
}, 300_000);
afterAll(() => db.$disconnect());

/** The slowest warm run of `read`, in ms. */
async function slowest(read: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const start = performance.now();
    await read();
    times.push(performance.now() - start);
  }
  return Math.max(...times.slice(1));
}

describe("Reports timing (10,000 orders over 90 days)", () => {
  it("has the cohort it claims", async () => {
    const report = await cycleTime(db, admin, range);
    expect(report.total.count).toBe(ORDERS);
    expect(await db.qualityIssue.count()).toBeGreaterThan(1_500);
  }, 60_000);

  it("answers Throughput for 90 days in under 1 s", async () => {
    expect(await slowest(() => throughput(db, admin, range))).toBeLessThan(1_000);
  }, 60_000);

  it("answers Cycle time for 90 days in under 1 s", async () => {
    expect(await slowest(() => cycleTime(db, admin, range))).toBeLessThan(1_000);
  }, 60_000);

  it("answers Quality for 90 days in under 1 s", async () => {
    expect(await slowest(() => quality(db, admin, range))).toBeLessThan(1_000);
  }, 60_000);

  it("answers the home tiles in under 1 s", async () => {
    expect(await slowest(() => reportsToday(db, admin, { timeZone }, now))).toBeLessThan(1_000);
  }, 60_000);

  it("streams a 90-day throughput CSV in under 5 s", async () => {
    const stream = async () => {
      const csv = await throughputCsv(db, admin, range, { locale: "en" });
      let rows = 0;
      for await (const _ of csv.rows) rows += 1;
      expect(rows).toBeGreaterThan(DAYS * 4);
    };
    expect(await slowest(stream)).toBeLessThan(5_000);
  }, 60_000);
});
