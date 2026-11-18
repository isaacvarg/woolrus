import type { Db } from "@woolrus/db";
import { seedDemoOrders } from "@woolrus/db/demo";
import { seedReportingHistory } from "@woolrus/db/demo-reporting";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { Actor } from "../permissions";
import { cycleTime } from "./cycle-time";
import { quality } from "./quality";
import { throughput } from "./throughput";
import { reportsToday } from "./today";

// SPEC-reporting "Dev data": after `pnpm db:seed`, every Reports tab and the home tiles have
// something plausible to show over the last 30 days (ticket #218).

const db: Db = testDb();
const timeZone = "America/Chicago";
// Mid-afternoon in Chicago, so "today" already has shipments.
const now = new Date("2026-11-18T21:00:00Z");
const range = { from: "2026-10-20", to: "2026-11-18", timeZone };
let admin: Actor;

beforeAll(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
  await seedDemoOrders(db, { now });
  await seedReportingHistory(db, { now });
}, 120_000);
afterAll(() => db.$disconnect());

describe("seedReportingHistory", () => {
  it("spreads completed orders over the last 30 days, and re-running adds nothing", async () => {
    const before = {
      orders: await db.order.count(),
      events: await db.orderStageEvent.count(),
      issues: await db.qualityIssue.count(),
      misses: await db.scanMiss.count(),
    };
    expect(await seedReportingHistory(db, { now })).toBe(0);
    expect({
      orders: await db.order.count(),
      events: await db.orderStageEvent.count(),
      issues: await db.qualityIssue.count(),
      misses: await db.scanMiss.count(),
    }).toEqual(before);

    const { days } = await throughput(db, admin, range);
    expect(days).toHaveLength(30);
    // Most days ship something; the warehouse doesn't stop for a whole week.
    expect(days.filter((d) => d.shipped > 0).length).toBeGreaterThanOrEqual(25);
    expect(days.filter((d) => d.imported > 0).length).toBeGreaterThanOrEqual(25);
  });

  it("gives Throughput orders and units for every stage, by named people", async () => {
    const { people } = await throughput(db, admin, range);

    for (const stage of ["PICKING", "PACKING", "QA", "SHIPPING"] as const) {
      const rows = people.filter((p) => p.stage === stage && p.person.id !== null);
      expect(rows.length, stage).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.person.name, stage).toBeTruthy();
        expect(row.orders, stage).toBeGreaterThan(0);
        expect(row.units, stage).toBeGreaterThan(0);
      }
    }
    // Two packers share the work, each with enough units for a quality rate.
    const packers = people.filter((p) => p.stage === "PACKING" && p.person.id !== null);
    expect(packers.length).toBeGreaterThanOrEqual(2);
    for (const p of packers) expect(p.units).toBeGreaterThanOrEqual(100);
  });

  it("gives Cycle time a cohort with waiting, working, idle, holds and a repack", async () => {
    const report = await cycleTime(db, admin, range);

    expect(report.total.count).toBeGreaterThanOrEqual(100);
    const hour = 3_600_000;
    // Hours to a couple of days from import to shipped, not seconds or weeks.
    expect(report.total.medianMs).toBeGreaterThan(2 * hour);
    expect(report.total.medianMs).toBeLessThan(48 * hour);
    expect(report.total.p90Ms).toBeGreaterThan(report.total.medianMs ?? 0);
    expect(report.onHold.meanMs).toBeGreaterThan(0);
    for (const stage of report.stages.filter((s) =>
      ["PICKING", "PACKING", "QA"].includes(s.stage),
    )) {
      expect(stage.working?.meanMs, stage.stage).toBeGreaterThan(0);
      // Starting a pick claims the order, so Picking has no waiting; the other two do.
      if (stage.stage !== "PICKING") expect(stage.waiting?.meanMs, stage.stage).toBeGreaterThan(0);
    }
    // Some pauses over the 10-minute cutoff.
    expect(report.stages.some((s) => (s.idle?.meanMs ?? 0) > 0)).toBe(true);
    expect(report.byDay.filter((d) => d.orders > 0).length).toBeGreaterThanOrEqual(25);
    expect(report.slowest).toHaveLength(20);

    // A repack: Ready → Packing → QA → Ready again before shipping.
    const repacked = await db.orderStageEvent.count({
      where: { fromStatus: "READY", toStatus: "PACKING", at: { gte: new Date("2026-10-20") } },
    });
    expect(repacked).toBeGreaterThan(0);
  });

  it("gives Quality issues of several types, rates, blocked scans of every kind and voids", async () => {
    const report = await quality(db, admin, range);

    expect(report.bucketSize).toBe("week");
    expect(report.byType.totals.length).toBeGreaterThanOrEqual(4);
    expect(report.byDiscoveredStage.totals.length).toBeGreaterThanOrEqual(3);
    expect(report.byOriginStage.totals.filter((t) => t.key !== null).length).toBeGreaterThan(1);
    expect(report.byPerson.totals.filter((t) => t.key !== null).length).toBeGreaterThan(1);
    expect(report.people.filter((p) => p.per1000 !== null).length).toBeGreaterThan(0);
    expect(report.byType.series.map((s) => s.bucket)).toEqual(
      expect.arrayContaining([report.buckets[0], report.buckets.at(-1)]),
    );

    const scans = report.scans.reduce(
      (sum, r) => ({
        notOnOrder: sum.notOnOrder + r.notOnOrder,
        alreadyDone: sum.alreadyDone + r.alreadyDone,
        otherPackage: sum.otherPackage + r.otherPackage,
        unknownCode: sum.unknownCode + r.unknownCode,
      }),
      { notOnOrder: 0, alreadyDone: 0, otherPackage: 0, unknownCode: 0 },
    );
    for (const [kind, count] of Object.entries(scans)) expect(count, kind).toBeGreaterThan(0);
    expect(new Set(report.scans.map((s) => s.stage)).size).toBe(3);
    expect(report.voids.length).toBeGreaterThan(0);

    const customer = await quality(db, admin, { ...range, customerReported: true });
    expect(customer.total).toBeGreaterThan(0);
  });

  it("gives the home tiles a shipped-today count and a 7-day median", async () => {
    const tiles = await reportsToday(db, admin, { timeZone }, now);

    expect(tiles.today).toBe("2026-11-18");
    expect(tiles.shippedToday).toBeGreaterThan(0);
    expect(tiles.medianCycleMs).toBeGreaterThan(0);
  });
});
