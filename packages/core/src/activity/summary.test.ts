import type { ActivityItem, ActivityParams, StageInterval, StagePerson } from "@woolrus/contracts";
import { describe, expect, it } from "vitest";
import { summarizeActivity } from "./summary";

const T0 = Date.UTC(2026, 10, 17, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const MIN = 60_000;

const ana = { id: "0199e6a0-0000-7000-8000-00000000000a", name: "Ana" };
const bruno = { id: "0199e6a0-0000-7000-8000-00000000000b", name: "Bruno" };
const carla = { id: "0199e6a0-0000-7000-8000-00000000000c", name: "Carla" };
type Person = typeof ana;

let seq = 0;
function item(
  min: number,
  action: string,
  who: Person | null,
  params: ActivityParams = {},
): ActivityItem {
  seq += 1;
  return {
    id: `0199e6a0-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    at: at(min),
    category: action.startsWith("stage.") ? "status" : "picking",
    action,
    entityType: "Order",
    actor: who,
    system: who ? null : "store-sync",
    station: null,
    target: null,
    params,
    details: null,
  };
}
const imported = (min: number) => item(min, "stage.import", null, { to: "PENDING" });
const move = (min: number, from: string, to: string, who: Person | null) =>
  item(min, "stage.move", who, { from, to, reason: null });

/** The timeline is newest first; the summary mustn't depend on it. */
const summarize = (items: ActivityItem[], nowMin: number) =>
  summarizeActivity([...items].reverse(), at(nowMin));

const stage = (result: ReturnType<typeof summarizeActivity>, name: string) => {
  const found = result.summary.stages.find((s) => s.stage === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};
const people = (result: ReturnType<typeof summarizeActivity>, name: string): StagePerson[] =>
  result.people.find((p) => p.stage === name)?.people ?? [];

/** SPEC-order-activity success criterion 6. */
function expectWaitingPlusWorking(result: ReturnType<typeof summarizeActivity>) {
  for (const s of result.summary.stages) {
    for (const interval of s.intervals) {
      if (["PICKING", "PACKING", "QA"].includes(s.stage)) {
        expect((interval.waitingMs ?? -1) + (interval.workingMs ?? -1)).toBe(interval.statusMs);
      } else {
        expect(interval).toMatchObject({ waitingMs: null, workingMs: null, firstActionAt: null });
      }
    }
  }
}

/** Import at 0, picked by Ana 10–20, packed by Bruno 30–45, QA by Carla 50–55, Ready until 70. */
const straightRun = () => [
  imported(0),
  move(10, "PENDING", "PICKING", ana),
  item(12, "pick.scan", ana),
  item(18, "pick.scan", ana),
  move(20, "PICKING", "PACKING", ana),
  item(30, "order.claim", bruno),
  item(40, "package.create", bruno),
  move(45, "PACKING", "QA", bruno),
  item(50, "order.claim", carla),
  move(55, "QA", "READY", carla),
  move(70, "READY", "COMPLETED", null),
];

describe("summarizeActivity", () => {
  it("a straight run: status time per stage, waiting before the first action, then working", () => {
    const result = summarize(straightRun(), 90);

    expect(result.summary.stages.map((s) => [s.stage, s.statusMs / MIN])).toEqual([
      ["PENDING", 10],
      ["PICKING", 10],
      ["PACKING", 25],
      ["QA", 10],
      ["READY", 15],
    ]);
    expect(result.summary.onHoldMs).toBe(0);
    // Picking starts with the picker's own beginPicking: no waiting.
    expect(stage(result, "PICKING").intervals).toEqual([
      expect.objectContaining({
        start: at(10),
        end: at(20),
        running: false,
        waitingMs: 0,
        workingMs: 10 * MIN,
        firstActionAt: at(10),
        batch: null,
      } satisfies Partial<StageInterval>),
    ]);
    // Ana's completePicking enters Packing but is her last picking action, not Bruno's first.
    expect(stage(result, "PACKING").intervals[0]).toMatchObject({
      waitingMs: 10 * MIN,
      workingMs: 15 * MIN,
      firstActionAt: at(30),
    });
    expect(stage(result, "QA").intervals[0]).toMatchObject({
      waitingMs: 5 * MIN,
      workingMs: 5 * MIN,
    });
    expect(stage(result, "PENDING").intervals[0]).toMatchObject({ waitingMs: null });

    expect(people(result, "PICKING")).toEqual([
      { ...ana, count: 4, firstAt: at(10), lastAt: at(20), spanMs: 10 * MIN },
    ]);
    expect(people(result, "PACKING")).toEqual([
      { ...bruno, count: 3, firstAt: at(30), lastAt: at(45), spanMs: 15 * MIN },
    ]);
    expect(people(result, "QA").map((p) => p.name)).toEqual(["Carla"]);
    expect(result.people.map((p) => p.stage)).toEqual(["PICKING", "PACKING", "QA"]);
    expectWaitingPlusWorking(result);
  });

  it("a repack makes a second Packing interval, each with its own waiting and working", () => {
    const result = summarize(
      [
        ...straightRun().slice(0, -1),
        move(60, "READY", "PACKING", carla),
        item(64, "package.update", bruno),
        move(66, "PACKING", "QA", bruno),
        item(67, "qa.scan", carla),
        move(68, "QA", "READY", carla),
      ],
      80,
    );

    const packing = stage(result, "PACKING");
    expect(packing.intervals.map((i) => [i.start, i.end, i.waitingMs, i.workingMs])).toEqual([
      [at(20), at(45), 10 * MIN, 15 * MIN],
      [at(60), at(66), 4 * MIN, 2 * MIN],
    ]);
    expect(packing.statusMs).toBe(31 * MIN);
    expect(stage(result, "QA").intervals).toHaveLength(2);
    expect(stage(result, "READY").statusMs).toBe((5 + 12) * MIN);
    expect(people(result, "PACKING")).toEqual([
      { ...bruno, count: 5, firstAt: at(30), lastAt: at(66), spanMs: 36 * MIN },
    ]);
    expectWaitingPlusWorking(result);
  });

  it("a hold in the middle counts toward no stage and splits the stage around it", () => {
    const result = summarize(
      [
        imported(0),
        move(10, "PENDING", "PICKING", ana),
        item(12, "pick.scan", ana),
        move(15, "PICKING", "ON_HOLD", bruno),
        item(20, "note.create", bruno),
        move(40, "ON_HOLD", "PICKING", bruno),
        item(45, "pick.scan", ana),
        move(50, "PICKING", "PACKING", ana),
      ],
      60,
    );

    expect(result.summary.onHoldMs).toBe(25 * MIN);
    const picking = stage(result, "PICKING");
    expect(picking.statusMs).toBe(15 * MIN);
    expect(picking.intervals.map((i) => [i.waitingMs, i.workingMs])).toEqual([
      [0, 5 * MIN],
      [5 * MIN, 5 * MIN],
    ]);
    // Bruno's hold is his action in Picking; his note during the hold is in no stage.
    expect(people(result, "PICKING")).toEqual([
      { ...ana, count: 4, firstAt: at(10), lastAt: at(50), spanMs: 40 * MIN },
      { ...bruno, count: 1, firstAt: at(15), lastAt: at(15), spanMs: 0 },
    ]);
    expect(stage(result, "PACKING").intervals[0]).toMatchObject({ running: true, end: at(60) });
    expectWaitingPlusWorking(result);
  });

  it("an order still in QA runs its interval to now; later stages have none", () => {
    const result = summarize([...straightRun().slice(0, 8), item(52, "qa.scan", carla)], 58);

    expect(stage(result, "QA").intervals).toEqual([
      expect.objectContaining({
        start: at(45),
        end: at(58),
        running: true,
        statusMs: 13 * MIN,
        waitingMs: 7 * MIN,
        workingMs: 6 * MIN,
      }),
    ]);
    expect(stage(result, "READY")).toEqual({ stage: "READY", statusMs: 0, intervals: [] });
    expectWaitingPlusWorking(result);
  });

  it("a work interval nobody has touched yet is all waiting", () => {
    const result = summarize([imported(0), move(5, "PENDING", "PICKING", null)], 20);

    expect(stage(result, "PICKING").intervals[0]).toMatchObject({
      waitingMs: 15 * MIN,
      workingMs: 0,
      firstActionAt: null,
    });
    expect(people(result, "PICKING")).toEqual([]);
    expectWaitingPlusWorking(result);
  });

  it("a pick begun from a batch says which batch and how many orders", () => {
    const result = summarize(
      [
        imported(0),
        move(10, "PENDING", "PICKING", ana),
        // Written in the same transaction as the move.
        item(10, "pickBatch.create", ana, { number: 7, orders: 4 }),
        item(15, "pick.scan", ana),
        move(20, "PICKING", "PACKING", ana),
      ],
      30,
    );

    expect(stage(result, "PICKING").intervals[0]).toMatchObject({
      batch: { number: 7, orders: 4 },
      waitingMs: 0,
    });
    expect(stage(result, "PACKING").intervals[0]?.batch).toBeNull();
    expect(people(result, "PICKING")[0]?.count).toBe(4);
    expectWaitingPlusWorking(result);
  });

  it("two people in one stage, in order of their first action", () => {
    const result = summarize(
      [
        ...straightRun().slice(0, 6),
        item(32, "package.create", carla),
        item(38, "package.update", carla),
        ...straightRun().slice(6),
      ],
      90,
    );

    expect(people(result, "PACKING")).toEqual([
      { ...bruno, count: 3, firstAt: at(30), lastAt: at(45), spanMs: 15 * MIN },
      { ...carla, count: 2, firstAt: at(32), lastAt: at(38), spanMs: 6 * MIN },
    ]);
    expect(stage(result, "PACKING").intervals[0]?.firstActionAt).toEqual(at(30));
    expectWaitingPlusWorking(result);
  });

  it("an order with no stage events has empty stages", () => {
    const result = summarize([], 10);
    expect(result.summary.stages.every((s) => s.statusMs === 0 && s.intervals.length === 0)).toBe(
      true,
    );
    expect(result.people.every((p) => p.people.length === 0)).toBe(true);
  });
});
