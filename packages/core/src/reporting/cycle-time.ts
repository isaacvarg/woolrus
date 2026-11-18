import {
  CYCLE_TIME_SLOWEST,
  CycleTimeInput,
  type CycleTimeReport,
  type CycleTimeStage,
  type DurationStat,
  SummaryStage,
  WorkStage,
} from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import { stageIntervals } from "../activity/summary";
import { summaryItems } from "../activity/summary-items";
import { type Actor, assertCan } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { type ExportOptions, exportKit, parseExportInput, type QueryOf } from "./exports";

// Cycle time (SPEC-reporting "Cycle time", FR-REP-02): how long the orders shipped in a range
// took. Each order's time per stage comes from `stageIntervals` over the same records the History
// tab reads, so the report and the tab can't disagree. The figures are worked out here, not in
// SQL, because the interval rules live there; a 90-day cohort is a few thousand orders.

type StageTimes = {
  entered: boolean;
  statusMs: number;
  waitingMs: number;
  workingMs: number;
  idleMs: number;
};

/** One order of the cohort, as the report and its CSV read it. */
type OrderCycle = {
  id: string;
  number: string;
  importedAt: Date;
  shippedAt: Date;
  /** The local day it shipped, YYYY-MM-DD. */
  day: string;
  totalMs: number;
  onHoldMs: number;
  stages: Record<SummaryStage, StageTimes>;
};

/** Count, median, nearest-rank p90 and mean of `values`, rounded to whole units. */
export function durationStat(values: readonly number[]): DurationStat {
  const n = values.length;
  if (n === 0) return { count: 0, medianMs: null, p90Ms: null, meanMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (i: number) => sorted[i] as number;
  const mid = Math.floor(n / 2);
  return {
    count: n,
    medianMs: n % 2 === 1 ? at(mid) : Math.round((at(mid - 1) + at(mid)) / 2),
    p90Ms: at(Math.ceil(0.9 * n) - 1),
    meanMs: Math.round(sorted.reduce((sum, v) => sum + v, 0) / n),
  };
}

/** Orders with a move to Completed in the range (the latest, if several), oldest shipped first. */
async function cohort(db: DbTx, input: unknown): Promise<OrderCycle[]> {
  const { from, to, timeZone } = parseExportInput(CycleTimeInput, input);
  // Local midnights as instants, so the `[to_status, at]` index serves the range.
  const rows = await db.$queryRaw<
    { id: string; number: string; shippedAt: Date; day: string; importedAt: Date }[]
  >`
    WITH shipped AS (
      SELECT DISTINCT ON (e.order_id) e.order_id AS id, e.at
      FROM order_stage_events e
      WHERE e.to_status = 'COMPLETED'
        AND e.at >= (${from}::date)::timestamp AT TIME ZONE ${timeZone}
        AND e.at < (${to}::date + 1)::timestamp AT TIME ZONE ${timeZone}
      ORDER BY e.order_id, e.at DESC
    )
    SELECT s.id, o.number, s.at AS "shippedAt",
      to_char(s.at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
      (SELECT MIN(f.at) FROM order_stage_events f WHERE f.order_id = s.id) AS "importedAt"
    FROM shipped s JOIN orders o ON o.id = s.id
    ORDER BY s.at ASC, s.id ASC`;

  const items = await summaryItems(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const shipped = row.shippedAt.getTime();
    // As of the move to Completed: anything later (a reopen, a note) is after the cycle.
    const own = (items.get(row.id) ?? []).filter((item) => item.at.getTime() <= shipped);
    const summary = stageIntervals(own, row.shippedAt);
    const stages = Object.fromEntries(
      summary.stages.map((s) => {
        const total = (key: "waitingMs" | "workingMs" | "idleMs") =>
          s.intervals.reduce((sum, i) => sum + (i[key] ?? 0), 0);
        return [
          s.stage,
          {
            entered: s.intervals.length > 0,
            statusMs: s.statusMs,
            waitingMs: total("waitingMs"),
            workingMs: total("workingMs"),
            idleMs: total("idleMs"),
          },
        ];
      }),
    ) as Record<SummaryStage, StageTimes>;
    return {
      id: row.id,
      number: row.number,
      importedAt: row.importedAt,
      shippedAt: row.shippedAt,
      day: row.day,
      totalMs: shipped - row.importedAt.getTime(),
      onHoldMs: summary.onHoldMs,
      stages,
    };
  });
}

/** Every day from `from` to `to`, inclusive. */
function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = new Date(`${from}T00:00:00Z`); at.toISOString().slice(0, 10) <= to; ) {
    days.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return days;
}

const isWork = (stage: SummaryStage) => WorkStage.safeParse(stage).success;

/** `reports.cycleTime`: figures over the orders shipped in the range; `report.read`. */
export async function cycleTime(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof CycleTimeInput>,
): Promise<CycleTimeReport> {
  assertCan(actor, "report.read");
  const { from, to } = parseExportInput(CycleTimeInput, input);
  const orders = await cohort(db, input);

  const stages = SummaryStage.options.map((stage): CycleTimeStage => {
    const entered = orders.map((o) => o.stages[stage]).filter((s) => s.entered);
    const of = (key: keyof Omit<StageTimes, "entered">) => durationStat(entered.map((s) => s[key]));
    return {
      stage,
      status: of("statusMs"),
      waiting: isWork(stage) ? of("waitingMs") : null,
      working: isWork(stage) ? of("workingMs") : null,
      idle: isWork(stage) ? of("idleMs") : null,
    };
  });

  const byDay = daysOf(from, to).map((day) => {
    const shipped = durationStat(orders.filter((o) => o.day === day).map((o) => o.totalMs));
    return { day, orders: shipped.count, medianMs: shipped.medianMs };
  });

  const slowest = [...orders]
    .sort((a, b) => b.totalMs - a.totalMs || a.shippedAt.getTime() - b.shippedAt.getTime())
    .slice(0, CYCLE_TIME_SLOWEST)
    .map(({ id, number, importedAt, shippedAt, totalMs, onHoldMs }) => ({
      id,
      number,
      importedAt,
      shippedAt,
      totalMs,
      onHoldMs,
    }));

  return {
    total: durationStat(orders.map((o) => o.totalMs)),
    onHold: durationStat(orders.map((o) => o.onHoldMs)),
    stages,
    byDay,
    slowest,
  };
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** Per stage, the CSV's columns and what each reads. */
const STAGE_COLUMNS = [
  ["PENDING", "pendingMin", "statusMs"],
  ["PICKING", "pickingMin", "statusMs"],
  ["PICKING", "pickingWaitingMin", "waitingMs"],
  ["PICKING", "pickingWorkingMin", "workingMs"],
  ["PICKING", "pickingIdleMin", "idleMs"],
  ["PACKING", "packingMin", "statusMs"],
  ["PACKING", "packingWaitingMin", "waitingMs"],
  ["PACKING", "packingWorkingMin", "workingMs"],
  ["PACKING", "packingIdleMin", "idleMs"],
  ["QA", "qaMin", "statusMs"],
  ["QA", "qaWaitingMin", "waitingMs"],
  ["QA", "qaWorkingMin", "workingMs"],
  ["QA", "qaIdleMin", "idleMs"],
  ["READY", "readyMin", "statusMs"],
] as const satisfies readonly (readonly [SummaryStage, string, keyof StageTimes])[];

/**
 * `GET /api/reports/cycle-time.csv`: one row per order in the cohort, oldest shipped first, with
 * its durations in whole minutes; `report.read`.
 */
export async function cycleTimeCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof CycleTimeInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const { from, to, timeZone } = parseExportInput(CycleTimeInput, input);
  const kit = exportKit("cycle-time", timeZone, options);
  const orders = await cohort(db, input);

  async function* rows() {
    for (const o of orders) {
      yield [
        o.number,
        kit.time(o.importedAt),
        kit.time(o.shippedAt),
        minutes(o.totalMs),
        minutes(o.onHoldMs),
        ...STAGE_COLUMNS.map(([stage, , key]) => minutes(o.stages[stage][key])),
      ];
    }
  }
  return {
    filename: `woolrus-cycle-time-${from}-${to}.csv`,
    header: kit.header([
      "order",
      "imported",
      "shippedAt",
      "totalMin",
      "onHoldMin",
      ...STAGE_COLUMNS.map(([, column]) => column),
    ]),
    rows: kit.capped(rows()),
  };
}
