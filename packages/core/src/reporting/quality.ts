import {
  FulfillmentStage,
  QUALITY_RATE_MIN_UNITS,
  QualityExportInput,
  QualityInput,
  QualityIssueType,
  type QualityPersonRate,
  type QualityPersonRef,
  type QualityReport,
  type QualityScanRow,
  type QualityVoidRow,
  qualityBucketSize,
  ScanMissesExportInput,
  ScanMissStage,
  ThroughputStage,
  VoidResolution,
} from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import type { CsvCell } from "../csv";
import { AppError } from "../errors";
import { issueListWhere } from "../exceptions/issues-queries";
import { type Actor, assertCan } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { type ExportOptions, exportKit, parseExportInput, type QueryOf } from "./exports";
import { daysOf, throughputUnits } from "./throughput";

// Quality (FR-QI-07, SPEC-reporting "Quality"): issues created in the range per day or week (Monday
// start, in the viewer's zone) by type, discovered stage, origin stage and responsible person; each
// person's issues per 1,000 units they handled in the origin stage, from 100 units; blocked scans by
// stage, kind and person; voids by stage and resolution. Counts are training signals, not rankings,
// so nothing here sorts people by how many issues they have: people go by name.

const DAY_MS = 86_400_000;

type Range = { from: string; to: string; timeZone: string };
type Filters = Pick<QualityInput, "severity" | "customerReported" | "status">;

/** The Monday on or before `day` (YYYY-MM-DD); read at UTC midnight, so no zone moves it. */
function mondayOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - weekday * DAY_MS).toISOString().slice(0, 10);
}

function bucketsOf(range: Range, size: "day" | "week"): string[] {
  if (size === "day") return daysOf(range.from, range.to);
  const out: string[] = [];
  const last = Date.parse(`${mondayOf(range.to)}T00:00:00Z`);
  for (let at = Date.parse(`${mondayOf(range.from)}T00:00:00Z`); at <= last; at += 7 * DAY_MS)
    out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/** The range on `column`, cut at local days; the UTC margin lets a time index narrow the scan. */
function inRange(column: Prisma.Sql, { from, to, timeZone }: Range): Prisma.Sql {
  const since = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS);
  const until = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS);
  return Prisma.sql`${column} >= ${since} AND ${column} < ${until}
    AND (${column} AT TIME ZONE ${timeZone})::date BETWEEN ${from}::date AND ${to}::date`;
}

/** Issues created in the range with the screen's filters, over `quality_issues i JOIN orders o`. */
function issueWhere(range: Range, { severity, customerReported, status }: Filters): Prisma.Sql {
  return Prisma.sql`${issueListWhere({ status, severity })}
    AND ${inRange(Prisma.sql`i.created_at`, range)}
    ${customerReported ? Prisma.sql`AND i.customer_reported` : Prisma.empty}`;
}

/** Enum order, null last. */
function enumOrder<T extends string>(options: readonly T[]) {
  const index = new Map<string | null, number>(options.map((o, i) => [o, i]));
  return (a: T | null, b: T | null) =>
    (index.get(a) ?? options.length) - (index.get(b) ?? options.length);
}

type Key = string | null;
type Cell = { bucket: string; key: Key; count: number };

/** Sums `cells` per bucket × key and per key; totals largest first, ties in `order`. */
function breakdown<K extends Key>(
  cells: { bucket: string; key: K; count: number }[],
  order: (a: K, b: K) => number,
) {
  const series = new Map<string, Cell & { key: K }>();
  const totals = new Map<K, { key: K; count: number }>();
  for (const c of cells) {
    const id = `${c.bucket}|${c.key}`;
    const cell = series.get(id) ?? { bucket: c.bucket, key: c.key, count: 0 };
    cell.count += c.count;
    series.set(id, cell);
    const total = totals.get(c.key) ?? { key: c.key, count: 0 };
    total.count += c.count;
    totals.set(c.key, total);
  }
  return {
    series: [...series.values()].sort(
      (a, b) => a.bucket.localeCompare(b.bucket) || order(a.key, b.key),
    ),
    totals: [...totals.values()].sort((a, b) => b.count - a.count || order(a.key, b.key)),
  };
}

type IssueCell = {
  bucket: string;
  type: QualityIssueType;
  discoveredStage: FulfillmentStage;
  originStage: FulfillmentStage | null;
  personId: string | null;
  count: number;
};

type ScanCell = Omit<QualityScanRow, "person"> & { personId: string | null };

function parseInput(input: unknown) {
  const parsed = QualityInput.safeParse(input);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "errors.validation");
  return parsed.data;
}

const byStage = enumOrder(FulfillmentStage.options);
const throughputStages = new Set<string>(ThroughputStage.options);

/** Issues, blocked scans and voids over the range; the filters narrow the issues only. */
export async function quality(db: DbTx, actor: Actor, input: QualityInput): Promise<QualityReport> {
  assertCan(actor, "report.read");
  const { severity, customerReported, status, ...range } = parseInput(input);
  const bucketSize = qualityBucketSize(range);

  const [issues, scans, voids, units] = await Promise.all([
    db.$queryRaw<IssueCell[]>`
      SELECT to_char(date_trunc(${bucketSize}, i.created_at AT TIME ZONE ${range.timeZone}), 'YYYY-MM-DD')
          AS bucket,
        i.type::text AS type, i.discovered_stage::text AS "discoveredStage",
        i.origin_stage::text AS "originStage", i.responsible_user_id AS "personId",
        count(*)::int AS count
      FROM quality_issues i JOIN orders o ON o.id = i.order_id
      ${issueWhere(range, { severity, customerReported, status })}
      GROUP BY 1, 2, 3, 4, 5`,
    db.$queryRaw<ScanCell[]>`
      SELECT m.stage::text AS stage, m.actor_id AS "personId",
        count(*) FILTER (WHERE m.kind = 'NOT_ON_ORDER')::int AS "notOnOrder",
        count(*) FILTER (WHERE m.kind = 'ALREADY_DONE')::int AS "alreadyDone",
        count(*) FILTER (WHERE m.kind = 'OTHER_PACKAGE')::int AS "otherPackage",
        count(*) FILTER (WHERE m.kind = 'UNKNOWN_CODE')::int AS "unknownCode"
      FROM scan_misses m
      WHERE ${inRange(Prisma.sql`m.at`, range)}
      GROUP BY 1, 2`,
    db.$queryRaw<QualityVoidRow[]>`
      SELECT v.stage::text AS stage, v.resolution::text AS resolution,
        count(*)::int AS voids, sum(v.quantity)::int AS units
      FROM item_voids v
      WHERE v.undone_at IS NULL AND ${inRange(Prisma.sql`v.voided_at`, range)}
      GROUP BY 1, 2`,
    throughputUnits(db, range),
  ]);

  const ids = [...new Set([...issues, ...scans].flatMap((c) => (c.personId ? [c.personId] : [])))];
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name.trim() || null]));
  const ref = (id: string | null): QualityPersonRef => ({
    id,
    name: id === null ? null : (names.get(id) ?? null),
  });
  const byPersonRef = (a: Key, b: Key) => {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return (names.get(a) ?? "").localeCompare(names.get(b) ?? "") || a.localeCompare(b);
  };

  const unitsOf = new Map(units.map((u) => [`${u.stage}:${u.personId}`, u.units]));
  const rates = new Map<string, QualityPersonRate>();
  for (const c of issues) {
    if (c.personId === null) continue;
    const id = `${c.originStage}:${c.personId}`;
    const rate = rates.get(id) ?? {
      person: ref(c.personId),
      stage: c.originStage,
      issues: 0,
      units:
        c.originStage && throughputStages.has(c.originStage)
          ? (unitsOf.get(`${c.originStage}:${c.personId}`) ?? 0)
          : null,
      per1000: null,
    };
    rate.issues += c.count;
    rates.set(id, rate);
  }
  for (const rate of rates.values())
    if (rate.units !== null && rate.units >= QUALITY_RATE_MIN_UNITS)
      rate.per1000 = Math.round((rate.issues * 10_000) / rate.units) / 10;

  const cells = <K extends Key>(key: (c: IssueCell) => K) =>
    issues.map((c) => ({ bucket: c.bucket, key: key(c), count: c.count }));
  const scanStage = enumOrder(ScanMissStage.options);
  const resolution = enumOrder(VoidResolution.options);

  return {
    bucketSize,
    buckets: bucketsOf(range, bucketSize),
    total: issues.reduce((n, c) => n + c.count, 0),
    byType: breakdown(
      cells((c) => c.type),
      enumOrder(QualityIssueType.options),
    ),
    byDiscoveredStage: breakdown(
      cells((c) => c.discoveredStage),
      byStage,
    ),
    byOriginStage: breakdown(
      cells((c) => c.originStage),
      byStage,
    ),
    byPerson: breakdown(
      cells((c) => c.personId),
      byPersonRef,
    ),
    people: [...rates.values()].sort(
      (a, b) => byPersonRef(a.person.id, b.person.id) || byStage(a.stage, b.stage),
    ),
    scans: scans
      .map(({ personId, ...counts }) => ({ ...counts, person: ref(personId) }))
      .sort((a, b) => scanStage(a.stage, b.stage) || byPersonRef(a.person.id, b.person.id)),
    voids: voids.sort(
      (a, b) => byStage(a.stage, b.stage) || resolution(a.resolution, b.resolution),
    ),
  };
}

// ─── CSV ──────────────────────────────────────────────────────────────────────────────────────

/** One row per issue in the range with the Quality tab's filters, oldest first; `report.read`. */
export async function qualityCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof QualityExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const { severity, customerReported, status, ...range } = parseExportInput(
    QualityExportInput,
    input,
  );
  const kit = exportKit("quality", range.timeZone, options);
  const issues = await db.$queryRaw<
    {
      number: string;
      createdAt: Date;
      type: string;
      severity: string;
      status: string;
      discoveredStage: string;
      originStage: string | null;
      responsible: string | null;
      customerReported: boolean;
      resolvedAt: Date | null;
    }[]
  >`
    SELECT o.number, i.created_at AS "createdAt", i.type::text AS type, i.severity::text AS severity,
      i.status::text AS status, i.discovered_stage::text AS "discoveredStage",
      i.origin_stage::text AS "originStage", nullif(trim(u.name), '') AS responsible,
      i.customer_reported AS "customerReported", i.resolved_at AS "resolvedAt"
    FROM quality_issues i JOIN orders o ON o.id = i.order_id
    LEFT JOIN users u ON u.id = i.responsible_user_id
    ${issueWhere(range, { severity, customerReported, status })}
    ORDER BY i.created_at ASC, i.id ASC
    LIMIT ${kit.max + 1}`;

  async function* rows(): AsyncGenerator<readonly CsvCell[]> {
    for (const i of issues)
      yield [
        i.number,
        kit.time(i.createdAt),
        i.type,
        i.severity,
        i.status,
        i.discoveredStage,
        i.originStage,
        i.responsible,
        kit.yesNo(i.customerReported),
        kit.time(i.resolvedAt),
      ];
  }
  return {
    filename: `woolrus-quality-${range.from}-${range.to}.csv`,
    header: kit.header([
      "order",
      "created",
      "type",
      "severity",
      "status",
      "discoveredStage",
      "originStage",
      "responsible",
      "customerReported",
      "resolvedAt",
    ]),
    rows: kit.capped(rows()),
  };
}

/** One row per blocked scan in the range, oldest first; `report.read`. */
export async function scanMissesCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof ScanMissesExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const range = parseExportInput(ScanMissesExportInput, input);
  const kit = exportKit("scan-misses", range.timeZone, options);
  const misses = await db.$queryRaw<
    {
      number: string;
      at: Date;
      stage: string;
      kind: string;
      code: string;
      product: string | null;
      person: string | null;
      station: string | null;
    }[]
  >`
    SELECT o.number, m.at, m.stage::text AS stage, m.kind::text AS kind, m.code,
      m.product_name AS product, nullif(trim(u.name), '') AS person, s.name AS station
    FROM scan_misses m JOIN orders o ON o.id = m.order_id
    LEFT JOIN users u ON u.id = m.actor_id
    LEFT JOIN stations s ON s.id = m.station_id
    WHERE ${inRange(Prisma.sql`m.at`, range)}
    ORDER BY m.at ASC, m.id ASC
    LIMIT ${kit.max + 1}`;

  async function* rows(): AsyncGenerator<readonly CsvCell[]> {
    for (const m of misses)
      yield [m.number, kit.time(m.at), m.stage, m.kind, m.code, m.product, m.person, m.station];
  }
  return {
    filename: `woolrus-scan-misses-${range.from}-${range.to}.csv`,
    header: kit.header([
      "order",
      "scannedAt",
      "stage",
      "kind",
      "code",
      "product",
      "person",
      "station",
    ]),
    rows: kit.capped(rows()),
  };
}
