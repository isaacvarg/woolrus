import {
  type ActivityItem,
  type OrderActivitySummary,
  type StageInterval,
  type StagePeople,
  type StagePerson,
  SummaryStage,
  WorkStage,
} from "@woolrus/contracts";
import type { WorkflowStatus } from "@woolrus/db";
import { transitions } from "../workflow/machine";

// The stage summary (SPEC-order-activity "Stage summary"). Pure: built from the timeline's items,
// whose stage events (`stage.import`, `stage.move`) give the intervals. The Cycle time report
// (SPEC-reporting) reads the same `stageIntervals`, so the two can't disagree.

/**
 * A gap of more than this between consecutive actions by people in a work interval is idle, not
 * working (SPEC-reporting decision 6, answering order-activity open question 1). A constant, not a
 * setting, until the floor asks for one.
 */
export const IDLE_CUTOFF_MS = 10 * 60_000;

/** Moves where the actor takes the claim (beginPicking): the move is their first action. */
const claimingMoves = transitions.filter((t) => t.claim === "claims");
const startsWork = (from: unknown, to: unknown) =>
  claimingMoves.some(
    (t) => t.from.includes(from as WorkflowStatus) && t.to.includes(to as WorkflowStatus),
  );

type Interval = {
  status: string;
  start: number;
  end: number;
  running: boolean;
  /** Entered by a person's claiming move: items at `start` belong here, not to the one before. */
  claimedAtStart: boolean;
  items: ActivityItem[];
};

const isWork = (stage: string): stage is WorkStage => WorkStage.safeParse(stage).success;

/** Time per status and who worked each stage, as of `now`: what the History tab shows. */
export function summarizeActivity(
  items: readonly ActivityItem[],
  now: Date,
): { summary: OrderActivitySummary; people: StagePeople[] } {
  const people = WorkStage.options.map((stage) => ({
    stage,
    people: peopleIn(placeItems(items, now).filter((i) => i.status === stage)),
  }));
  return { summary: stageIntervals(items, now), people };
}

/**
 * Time per status as of `now`, each work interval split into waiting, working and idle. Takes an
 * order's items in any order. Each item belongs to the interval that contains it, start exclusive
 * and end inclusive, so the move that leaves a stage is that stage's last action; the exception is
 * a claiming move, which opens its interval at its own time.
 */
export function stageIntervals(items: readonly ActivityItem[], now: Date): OrderActivitySummary {
  const intervals = placeItems(items, now);
  const stages = SummaryStage.options.map((stage) => {
    const own = intervals.filter((i) => i.status === stage).map((i) => toInterval(i, stage));
    return { stage, statusMs: sum(own.map((i) => i.statusMs)), intervals: own };
  });
  const onHoldMs = sum(intervals.filter((i) => i.status === "ON_HOLD").map((i) => i.end - i.start));
  return { stages, onHoldMs };
}

/** The order's intervals, oldest first, each holding its items oldest first. */
function placeItems(items: readonly ActivityItem[], now: Date): Interval[] {
  const oldestFirst = [...items].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1),
  );
  const intervals = buildIntervals(oldestFirst, now.getTime());
  for (const item of oldestFirst) intervalOf(intervals, item.at.getTime())?.items.push(item);
  return intervals;
}

function buildIntervals(oldestFirst: readonly ActivityItem[], now: number): Interval[] {
  const intervals: Interval[] = [];
  for (const item of oldestFirst) {
    if (item.action !== "stage.import" && item.action !== "stage.move") continue;
    const at = item.at.getTime();
    const previous = intervals.at(-1);
    if (previous) {
      previous.end = at;
      previous.running = false;
    }
    intervals.push({
      status: String(item.params.to),
      start: at,
      end: Math.max(at, now),
      running: true,
      claimedAtStart: item.actor !== null && startsWork(item.params.from, item.params.to),
      items: [],
    });
  }
  return intervals;
}

/** The latest interval holding `at`: (start, end], or [start, end] after a claiming move. */
function intervalOf(intervals: readonly Interval[], at: number): Interval | undefined {
  for (let i = intervals.length - 1; i >= 0; i--) {
    const interval = intervals[i];
    if (!interval) continue;
    const afterStart = interval.claimedAtStart ? at >= interval.start : at > interval.start;
    if (afterStart && at <= interval.end) return interval;
  }
  // The import itself, or anything before it.
  return intervals[0] && at <= intervals[0].end ? intervals[0] : undefined;
}

function toInterval(interval: Interval, stage: string): StageInterval {
  const statusMs = interval.end - interval.start;
  const base = {
    start: new Date(interval.start),
    end: new Date(interval.end),
    running: interval.running,
    statusMs,
  };
  if (!isWork(stage)) {
    return {
      ...base,
      waitingMs: null,
      workingMs: null,
      idleMs: null,
      firstActionAt: null,
      batch: null,
    };
  }
  // An item at the very start (a claiming move's own) waits for nothing.
  const actions = interval.items
    .filter((item) => item.actor !== null)
    .map((item) => Math.max(item.at.getTime(), interval.start));
  const firstAt = actions[0] ?? null;
  const waitingMs = firstAt === null ? statusMs : firstAt - interval.start;
  const idleMs = firstAt === null ? 0 : idleBetween([...actions, interval.end]);
  return {
    ...base,
    waitingMs,
    workingMs: statusMs - waitingMs - idleMs,
    idleMs,
    firstActionAt: firstAt === null ? null : new Date(firstAt),
    batch: stage === "PICKING" ? batchOf(interval) : null,
  };
}

/**
 * The gaps over the cutoff between consecutive times, oldest first. The last time is the
 * interval's end: usually the move out (a person's last action, gap 0); for an order still in the
 * stage, `now`, so a stage nobody has touched for a while shows that as idle too.
 */
function idleBetween(times: readonly number[]): number {
  let idle = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
    if (gap > IDLE_CUTOFF_MS) idle += gap;
  }
  return idle;
}

/** The batch this pick began in: its `pickBatch.create`, written with the move or later. */
function batchOf(interval: Interval): StageInterval["batch"] {
  const created = interval.items.find((item) => item.action === "pickBatch.create");
  if (!created) return null;
  const int = (value: unknown) => (typeof value === "number" ? value : null);
  return { number: int(created.params.number), orders: int(created.params.orders) };
}

function peopleIn(intervals: readonly Interval[]): StagePerson[] {
  const byId = new Map<string, StagePerson>();
  for (const item of intervals.flatMap((i) => i.items)) {
    if (!item.actor) continue;
    const seen = byId.get(item.actor.id);
    if (!seen) {
      byId.set(item.actor.id, {
        ...item.actor,
        count: 1,
        firstAt: item.at,
        lastAt: item.at,
        spanMs: 0,
      });
    } else {
      seen.count += 1;
      seen.lastAt = item.at;
      seen.spanMs = item.at.getTime() - seen.firstAt.getTime();
    }
  }
  return [...byId.values()].sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
}

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);
