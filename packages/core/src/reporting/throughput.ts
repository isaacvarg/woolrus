import {
  ThroughputExportInput,
  ThroughputInput,
  type ThroughputPersonRef,
  type ThroughputPersonTotal,
  type ThroughputReport,
  type ThroughputRow,
  ThroughputStage,
} from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import type { CsvCell } from "../csv";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { type ExportOptions, exportKit, parseExportInput, type QueryOf } from "./exports";

// Throughput (FR-REP-01, SPEC-reporting "Throughput"): orders and units per day × stage × person,
// aggregated in Postgres and bucketed by local day in the viewer's zone.
//
// Orders go to whoever moved the order out of the stage (Picking → Packing, Packing → QA,
// QA → Ready, Ready → Completed). Units go to whoever picked the line, packed or QA-verified the box
// line, or shipped the order (its live packages' units). A repack's passes each count, and a
// discarded package's lines still count for their packer: the work happened. Voided units are out
// of picking (the stored count is capped at the line's active quantity) and out of the boxes, which
// a void already trims. Work with no actor is the system's.

const DAY_MS = 86_400_000;

/** Every calendar day from `from` to `to`, inclusive. */
export function daysOf(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const count = Math.round((Date.parse(`${to}T00:00:00Z`) - start) / DAY_MS) + 1;
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * DAY_MS).toISOString().slice(0, 10),
  );
}

type Cell = {
  day: string;
  stage: ThroughputStage;
  personId: string | null;
  orders: number;
  units: number;
};

const stageOrder = new Map(ThroughputStage.options.map((stage, i) => [stage, i]));

/** By name, the system last. */
function byPerson(a: ThroughputPersonRef, b: ThroughputPersonRef): number {
  if (a.id === null || b.id === null) return a.id === b.id ? 0 : a.id === null ? 1 : -1;
  return (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id);
}

type Range = { from: string; to: string; timeZone: string };

/**
 * A day either side of the UTC midnights covers every zone offset and lets the time indexes narrow
 * the scan; the exact cut is on the local date. Parameters $1–$5 are from, to, zone, since, until.
 */
function rangeSql({ from, to, timeZone }: Range) {
  const since = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS);
  const until = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS);
  const local = (column: string) => `(${column} AT TIME ZONE $3)::date`;
  const inRange = (column: string) =>
    `${column} >= $4 AND ${column} < $5 AND ${local(column)} BETWEEN $1::date AND $2::date`;
  return { local, inRange, params: [from, to, timeZone, since, until] as const };
}

/** Orders and units per local day × stage × person; non-zero cells only. */
function workCells(db: DbTx, range: Range): Promise<Cell[]> {
  const { local, inRange, params } = rangeSql(range);
  return db.$queryRawUnsafe<Cell[]>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, stage, person_id AS "personId",
       sum(orders)::int AS orders, sum(units)::int AS units
     FROM (
       SELECT ${local("e.at")} AS day,
         CASE e.from_status WHEN 'PICKING' THEN 'PICKING' WHEN 'PACKING' THEN 'PACKING'
           WHEN 'QA' THEN 'QA' ELSE 'SHIPPING' END AS stage,
         e.actor_id AS person_id, 1 AS orders,
         CASE WHEN e.from_status = 'READY' THEN (
           SELECT coalesce(sum(pi.quantity), 0) FROM package_items pi
           JOIN packages p ON p.id = pi.package_id AND p.discarded_at IS NULL
           WHERE p.order_id = e.order_id) ELSE 0 END AS units
       FROM order_stage_events e
       WHERE ${inRange("e.at")}
         AND (e.from_status, e.to_status) IN (('PICKING', 'PACKING'), ('PACKING', 'QA'),
           ('QA', 'READY'), ('READY', 'COMPLETED'))
       UNION ALL
       SELECT ${local("i.picked_at")}, 'PICKING', i.picked_by_id, 0,
         greatest(least(i.picked_quantity, i.quantity - coalesce((
           SELECT sum(v.quantity) FROM item_voids v
           WHERE v.order_item_id = i.id AND v.undone_at IS NULL), 0)), 0)
       FROM order_items i
       WHERE ${inRange("i.picked_at")} AND i.picked_quantity > 0
       UNION ALL
       SELECT ${local("pi.packed_at")}, 'PACKING', pi.packed_by_id, 0, pi.quantity
       FROM package_items pi
       WHERE ${inRange("pi.packed_at")}
       UNION ALL
       SELECT ${local("pi.qa_verified_at")}, 'QA', pi.qa_verified_by_id, 0, pi.quantity
       FROM package_items pi
       WHERE ${inRange("pi.qa_verified_at")}
     ) work
     GROUP BY day, stage, person_id
     HAVING sum(orders) > 0 OR sum(units) > 0`,
    ...params,
  );
}

/**
 * Units each person handled per stage over the range, exactly as Throughput counts them; the
 * system's (no actor) under a null id. Quality's per-person rates divide by these.
 */
export async function throughputUnits(
  db: DbTx,
  range: Range,
): Promise<{ stage: ThroughputStage; personId: string | null; units: number }[]> {
  const totals = new Map<
    string,
    { stage: ThroughputStage; personId: string | null; units: number }
  >();
  for (const cell of await workCells(db, range)) {
    const key = `${cell.stage}:${cell.personId}`;
    const total = totals.get(key) ?? { stage: cell.stage, personId: cell.personId, units: 0 };
    total.units += cell.units;
    totals.set(key, total);
  }
  return [...totals.values()];
}

async function readCells(
  db: DbTx,
  range: Range,
): Promise<{ cells: Cell[]; days: ThroughputReport["days"] }> {
  const { local, inRange, params } = rangeSql(range);
  const [cells, warehouse] = await Promise.all([
    workCells(db, range),
    db.$queryRawUnsafe<{ day: string; imported: number; shipped: number }[]>(
      `SELECT to_char(${local("e.at")}, 'YYYY-MM-DD') AS day,
         count(*) FILTER (WHERE e.from_status IS NULL)::int AS imported,
         count(*) FILTER (WHERE e.to_status = 'COMPLETED' AND e.from_status IS NOT NULL)::int
           AS shipped
       FROM order_stage_events e
       WHERE ${inRange("e.at")} AND (e.from_status IS NULL OR e.to_status = 'COMPLETED')
       GROUP BY 1`,
      ...params,
    ),
  ]);
  const byDay = new Map(warehouse.map((row) => [row.day, row]));
  const days = daysOf(range.from, range.to).map((day) => ({
    day,
    imported: byDay.get(day)?.imported ?? 0,
    shipped: byDay.get(day)?.shipped ?? 0,
  }));
  return { cells, days };
}

function parseInput(input: unknown) {
  const parsed = ThroughputInput.safeParse(input);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "errors.validation");
  return parsed.data;
}

/** Orders and units per day × stage × person for the range, with the warehouse row per day. */
export async function throughput(
  db: DbTx,
  actor: Actor,
  input: ThroughputInput,
): Promise<ThroughputReport> {
  assertCan(actor, "report.read");
  const { stage, person, ...range } = parseInput(input);
  const { cells, days } = await readCells(db, range);

  const ids = [...new Set(cells.flatMap((c) => (c.personId ? [c.personId] : [])))];
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name.trim() || null]));
  const ref = (id: string | null): ThroughputPersonRef => ({
    id,
    name: id === null ? null : (names.get(id) ?? null),
  });
  const persons = [...new Map(cells.map((c) => [c.personId, ref(c.personId)])).values()].sort(
    byPerson,
  );

  const wanted = (c: Cell) =>
    (!stage || c.stage === stage) &&
    (!person || (person === "system" ? c.personId === null : c.personId === person));
  const rows: ThroughputRow[] = cells
    .filter(wanted)
    .map((c) => ({
      day: c.day,
      stage: c.stage,
      person: ref(c.personId),
      orders: c.orders,
      units: c.units,
    }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (stageOrder.get(a.stage) ?? 0) - (stageOrder.get(b.stage) ?? 0) ||
        byPerson(a.person, b.person),
    );

  const totals = new Map<string, ThroughputPersonTotal>();
  for (const row of rows) {
    const key = `${row.stage}:${row.person.id}`;
    const total = totals.get(key) ?? {
      stage: row.stage,
      person: row.person,
      orders: 0,
      units: 0,
      activeDays: 0,
    };
    total.orders += row.orders;
    total.units += row.units;
    total.activeDays += 1;
    totals.set(key, total);
  }
  const people = [...totals.values()].sort(
    (a, b) =>
      (stageOrder.get(a.stage) ?? 0) - (stageOrder.get(b.stage) ?? 0) ||
      byPerson(a.person, b.person),
  );

  return { days, rows, people, persons };
}

/** The throughput figures as CSV: one row per day × stage × person, with the screen's filters. */
export async function throughputCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof ThroughputExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const parsed = parseExportInput(ThroughputExportInput, input);
  const kit = exportKit("throughput", parsed.timeZone, options);
  const { rows } = await throughput(db, actor, parsed);
  const system = messages[options.locale].exports.system;

  async function* cells(): AsyncGenerator<readonly CsvCell[]> {
    for (const r of rows)
      yield [
        r.day,
        r.stage,
        r.person.id === null ? system : (r.person.name ?? ""),
        r.orders,
        r.units,
      ];
  }
  return {
    filename: `woolrus-throughput-${parsed.from}-${parsed.to}.csv`,
    header: kit.header(["day", "stage", "person", "orders", "units"]),
    rows: kit.capped(cells()),
  };
}
