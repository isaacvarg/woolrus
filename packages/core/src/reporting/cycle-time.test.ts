import type { Db, WorkflowStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fullActivity } from "../../test/activity";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { csvStream } from "../csv";
import type { UserActor } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { cycleTime, cycleTimeCsv, durationStat } from "./cycle-time";

// SPEC-reporting "Cycle time" (criterion 2): the cohort is the orders whose move to Completed
// falls in the range; figures are exact; holds count in no stage and are reported apart; a
// repack's Packing intervals sum; the report and the History tab agree for the same order.

const db: Db = testDb();
afterAll(() => db.$disconnect());

const MIN = 60_000;
const timeZone = "America/Chicago";
const range = { from: "2026-11-02", to: "2026-11-03", timeZone };

let admin: UserActor;
let picker: UserActor;
let packer: UserActor;
let qa: UserActor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
  picker = await createActor(db, ["PICKER"]);
  packer = await createActor(db, ["PACKER"]);
  qa = await createActor(db, ["QA"]);
});

type Step =
  | { min: number; to: WorkflowStatus; by?: UserActor }
  | { min: number; act: UserActor; action?: string };

/** An order with these stage events and audit rows, `min` minutes after `start`. */
async function orderWith(start: string, steps: Step[], number?: string) {
  const { order } = await createOrder(db, number ? { number } : {});
  const t0 = Date.parse(start);
  let from: WorkflowStatus | null = null;
  for (const step of steps) {
    const at = new Date(t0 + step.min * MIN);
    if ("to" in step) {
      await db.orderStageEvent.create({
        data: {
          orderId: order.id,
          fromStatus: from,
          toStatus: step.to,
          actorId: step.by?.userId,
          at,
        },
      });
      from = step.to;
    } else {
      await db.auditEvent.create({
        data: {
          orderId: order.id,
          actorId: step.act.userId,
          entityType: "OrderItem",
          entityId: crypto.randomUUID(),
          action: step.action ?? "orderItem.pick",
          at,
        },
      });
    }
  }
  return order;
}

/**
 * Pending 10; Picking 30 (claimed, a 25-minute pause: idle 25, working 5); Packing 20 (waiting
 * 10, working 10) then a repack's 10 (waiting 5, working 5); QA 10 + 10 (waiting 15, working 5);
 * Ready 5, on hold 30, Ready 15. Shipped at 140 minutes, 10:20 on Nov 2 in Chicago.
 */
const slowOrder = () =>
  orderWith(
    "2026-11-02T14:00:00Z",
    [
      { min: 0, to: "PENDING" },
      { min: 10, to: "PICKING", by: picker },
      { min: 12, act: picker },
      { min: 37, act: picker },
      { min: 40, to: "PACKING", by: picker },
      { min: 50, act: packer },
      { min: 59, act: packer },
      { min: 60, to: "QA", by: packer },
      { min: 70, to: "PACKING", by: qa },
      { min: 75, act: packer },
      { min: 80, to: "QA", by: packer },
      { min: 85, act: qa },
      { min: 90, to: "READY", by: qa },
      { min: 95, to: "ON_HOLD", by: admin },
      { min: 125, to: "READY", by: admin },
      { min: 140, to: "COMPLETED", by: admin },
    ],
    "A-1",
  );

/** Pending 20, Picking 10, Packing 10, QA 10, Ready 10: 60 minutes, shipped Nov 3. */
const plainOrder = () =>
  orderWith(
    "2026-11-03T15:00:00Z",
    [
      { min: 0, to: "PENDING" },
      { min: 20, to: "PICKING", by: picker },
      { min: 30, to: "PACKING", by: picker },
      { min: 40, to: "QA", by: packer },
      { min: 50, to: "READY", by: qa },
      { min: 60, to: "COMPLETED", by: admin },
    ],
    "B-1",
  );

/** 30 minutes in Pending, shipped at 23:30 on Nov 3 in Chicago (05:30 UTC on Nov 4). */
const lateOrder = () =>
  orderWith(
    "2026-11-04T05:00:00Z",
    [
      { min: 0, to: "PENDING" },
      { min: 30, to: "COMPLETED", by: admin },
    ],
    "E-1",
  );

const stat = (count: number, median: number, p90: number, mean: number) => ({
  count,
  medianMs: median * MIN,
  p90Ms: p90 * MIN,
  meanMs: Math.round(mean * MIN),
});

describe("durationStat", () => {
  it("gives count, median, nearest-rank p90 and mean, rounded to the millisecond", () => {
    expect(durationStat([30, 140, 60])).toEqual({ count: 3, medianMs: 60, p90Ms: 140, meanMs: 77 });
    expect(durationStat([1, 2, 3, 4])).toEqual({ count: 4, medianMs: 3, p90Ms: 4, meanMs: 3 });
    expect(durationStat([...Array(10).keys()].map((i) => i + 1))).toMatchObject({ p90Ms: 9 });
    expect(durationStat([])).toEqual({ count: 0, medianMs: null, p90Ms: null, meanMs: null });
  });
});

describe("reports.cycleTime", () => {
  it("needs report.read", async () => {
    for (const roles of [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"], ["RATE_LAB"]] as const) {
      const viewer = await createActor(db, [...roles]);
      await expect(cycleTime(db, viewer, range)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
    const lead = await createActor(db, ["PACKER", "REPORTS"]);
    await expect(cycleTime(db, lead, range)).resolves.toBeDefined();
    await expect(cycleTime(db, admin, range)).resolves.toBeDefined();
  });

  it("figures import → shipped and each stage over the orders shipped in the range", async () => {
    const slow = await slowOrder();
    const plain = await plainOrder();
    const late = await lateOrder();
    // Not in the cohort: still open; shipped after the range; shipped at 23:30 the day before it.
    await orderWith("2026-11-02T14:00:00Z", [
      { min: 0, to: "PENDING" },
      { min: 10, to: "PICKING", by: picker },
    ]);
    await orderWith("2026-11-05T15:00:00Z", [
      { min: 0, to: "PENDING" },
      { min: 10, to: "COMPLETED", by: admin },
    ]);
    await orderWith("2026-11-02T05:00:00Z", [
      { min: 0, to: "PENDING" },
      { min: 30, to: "COMPLETED", by: admin },
    ]);

    const report = await cycleTime(db, admin, range);

    expect(report.total).toEqual(stat(3, 60, 140, 230 / 3));
    expect(report.onHold).toEqual(stat(3, 0, 30, 10));
    const stages = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
    expect(report.stages.map((s) => s.stage)).toEqual([
      "PENDING",
      "PICKING",
      "PACKING",
      "QA",
      "READY",
    ]);
    expect(stages.PENDING).toEqual({
      stage: "PENDING",
      status: stat(3, 20, 30, 20),
      waiting: null,
      working: null,
      idle: null,
    });
    expect(stages.PICKING).toEqual({
      stage: "PICKING",
      status: stat(2, 20, 30, 20),
      waiting: stat(2, 0, 0, 0),
      working: stat(2, 7.5, 10, 7.5),
      idle: stat(2, 12.5, 25, 12.5),
    });
    // The repack's two Packing intervals sum: 30 for the slow order.
    expect(stages.PACKING).toEqual({
      stage: "PACKING",
      status: stat(2, 20, 30, 20),
      waiting: stat(2, 12.5, 15, 12.5),
      working: stat(2, 7.5, 15, 7.5),
      idle: stat(2, 0, 0, 0),
    });
    expect(stages.QA).toMatchObject({
      status: stat(2, 15, 20, 15),
      waiting: stat(2, 12.5, 15, 12.5),
      working: stat(2, 2.5, 5, 2.5),
    });
    // The hold counts in no stage: Ready is 5 + 15.
    expect(stages.READY?.status).toEqual(stat(2, 15, 20, 15));

    expect(report.byDay).toEqual([
      { day: "2026-11-02", orders: 1, medianMs: 140 * MIN },
      { day: "2026-11-03", orders: 2, medianMs: 45 * MIN },
    ]);
    expect(report.slowest.map((o) => [o.id, o.number, o.totalMs / MIN, o.onHoldMs / MIN])).toEqual([
      [slow.id, "A-1", 140, 30],
      [plain.id, "B-1", 60, 0],
      [late.id, "E-1", 30, 0],
    ]);
    expect(report.slowest[0]).toMatchObject({
      importedAt: new Date("2026-11-02T14:00:00Z"),
      shippedAt: new Date("2026-11-02T16:20:00Z"),
    });
  });

  it("gives every day of the range, with no figures for a day nothing shipped", async () => {
    const report = await cycleTime(db, admin, { ...range, to: "2026-11-04" });
    expect(report.byDay).toEqual([
      { day: "2026-11-02", orders: 0, medianMs: null },
      { day: "2026-11-03", orders: 0, medianMs: null },
      { day: "2026-11-04", orders: 0, medianMs: null },
    ]);
    expect(report.total.count).toBe(0);
    expect(report.stages[1]?.working).toEqual({
      count: 0,
      medianMs: null,
      p90Ms: null,
      meanMs: null,
    });
  });

  it("lists at most the 20 slowest orders", async () => {
    for (let i = 1; i <= 21; i++) {
      await orderWith("2026-11-02T14:00:00Z", [
        { min: 0, to: "PENDING" },
        { min: i, to: "COMPLETED", by: admin },
      ]);
    }
    const { slowest, total } = await cycleTime(db, admin, range);
    expect(total.count).toBe(21);
    expect(slowest.map((o) => o.totalMs / MIN)).toEqual([...Array(20).keys()].map((i) => 21 - i));
  });

  it("agrees with the History tab's summary for the same order", async () => {
    const order = await slowOrder();
    // A scan miss and a hidden audit row (a move's own row): the timeline reads the first and
    // leaves the second out, and so must the report. The miss at 20 splits Picking's pause.
    await db.scanMiss.create({
      data: {
        orderId: order.id,
        actorId: picker.userId,
        stage: "PICKING",
        kind: "UNKNOWN_CODE",
        code: "X",
        at: new Date(Date.parse("2026-11-02T14:00:00Z") + 20 * MIN),
      },
    });
    await db.auditEvent.create({
      data: {
        orderId: order.id,
        actorId: packer.userId,
        entityType: "Order",
        entityId: order.id,
        action: "order.completePicking",
        at: new Date(Date.parse("2026-11-02T14:00:00Z") + 41 * MIN),
      },
    });

    const feed = await fullActivity(db, admin, { id: order.id }, { now: new Date("2026-11-10") });
    const report = await cycleTime(db, admin, range);

    const sum = (values: (number | null)[]) => values.reduce<number>((t, v) => t + (v ?? 0), 0);
    for (const history of feed.summary.stages) {
      const row = report.stages.find((s) => s.stage === history.stage);
      expect(row?.status.medianMs, history.stage).toBe(history.statusMs);
      if (row?.waiting) {
        expect(row.waiting.medianMs).toBe(sum(history.intervals.map((i) => i.waitingMs)));
        expect(row.working?.medianMs).toBe(sum(history.intervals.map((i) => i.workingMs)));
        expect(row.idle?.medianMs).toBe(sum(history.intervals.map((i) => i.idleMs)));
      }
    }
    expect(report.onHold.medianMs).toBe(feed.summary.onHoldMs);
    // The miss split the 25-minute pause into 8 (working) and 17 (idle).
    expect(report.stages.find((s) => s.stage === "PICKING")?.idle?.medianMs).toBe(17 * MIN);
  });
});

describe("cycle-time.csv", () => {
  async function lines(csv: CsvExport): Promise<string[]> {
    const bytes = new Uint8Array(await new Response(csvStream(csv.header, csv.rows)).arrayBuffer());
    return new TextDecoder().decode(bytes.slice(3)).split("\r\n").slice(0, -1);
  }

  it("needs report.read", async () => {
    const viewer = await createActor(db, ["SHIPPER"]);
    await expect(cycleTimeCsv(db, viewer, range, { locale: "en" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const lead = await createActor(db, ["PACKER", "REPORTS"]);
    await expect(cycleTimeCsv(db, lead, range, { locale: "en" })).resolves.toBeDefined();
  });

  it("writes one row per order in the cohort, oldest shipped first, in whole minutes", async () => {
    await lateOrder();
    await slowOrder();
    await plainOrder();
    const csv = await cycleTimeCsv(db, admin, range, { locale: "en" });
    expect(csv.filename).toBe("woolrus-cycle-time-2026-11-02-2026-11-03.csv");
    const [header, ...rows] = await lines(csv);
    expect(header).toBe(
      [
        "Order",
        "Imported",
        "Shipped at",
        "Total (min)",
        "On hold (min)",
        "Pending (min)",
        "Picking (min)",
        "Picking waiting (min)",
        "Picking working (min)",
        "Picking idle (min)",
        "Packing (min)",
        "Packing waiting (min)",
        "Packing working (min)",
        "Packing idle (min)",
        "QA (min)",
        "QA waiting (min)",
        "QA working (min)",
        "QA idle (min)",
        "Ready (min)",
      ].join(","),
    );
    expect(rows).toEqual([
      "A-1,2026-11-02T08:00:00-06:00,2026-11-02T10:20:00-06:00,140,30,10,30,0,5,25,30,15,15,0,20,15,5,0,20",
      "B-1,2026-11-03T09:00:00-06:00,2026-11-03T10:00:00-06:00,60,0,20,10,0,10,0,10,10,0,0,10,10,0,0,10",
      "E-1,2026-11-03T23:00:00-06:00,2026-11-03T23:30:00-06:00,30,0,30,0,0,0,0,0,0,0,0,0,0,0,0,0",
    ]);
  });

  it("writes headers in the viewer's language", async () => {
    const csv = await cycleTimeCsv(db, admin, range, { locale: "es" });
    expect(csv.header[0]).toBe("Pedido");
    expect(csv.header).not.toContain("Total (min)");
  });
});
