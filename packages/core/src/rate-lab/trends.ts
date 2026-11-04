import {
  LAB_RUN_TREND_RUNS,
  LAB_TRENDS_REPORT_MAX,
  type LabRunTrend,
  LabRunTrendsInput,
  type LabTrendCell,
  type LabTrendGrid,
  LabTrendGridInput,
  type LabTrendLine,
  type LabTrendPrice,
  type LabTrendSeries,
  LabTrendSeriesInput,
  type LabTrendsReport,
} from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import type { z } from "zod";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";

// Rate Lab's Trends (SPEC-rate-lab "Trends"): the cheapest price of each test address × parcel in
// its latest suite run against the run before, and one line per carrier service across the runs.
// Only SUITE runs count (one-offs never do, decision 12); a run's time is when it started.

const DAY_MS = 24 * 60 * 60 * 1000;

/** One quote of a suite run's fetch for a test address × parcel. */
type QuoteRow = {
  fetchId: string;
  runId: string;
  at: Date;
  addressId: string;
  parcelId: string;
  carrierId: string;
  serviceId: string;
  serviceName: string;
  amountCents: number;
  deliveryDays: number | null;
  quoteOnly: boolean;
};

type Filters = {
  addressIds: string[];
  parcelIds: string[];
  carrierIds: string[];
  from?: string;
  to?: string;
  includeFake: boolean;
  /** Only each combination's newest this many runs. */
  latest?: number;
  /** Only runs at or before this time. */
  until?: Date;
};

/**
 * The quotes of suite-run fetches for these addresses and parcels. A fetch counts only when it has
 * a quote in the filters, so a failed combination never hides the run before it.
 */
async function loadQuotes(db: DbTx, f: Filters): Promise<QuoteRow[]> {
  if (f.addressIds.length === 0 || f.parcelIds.length === 0) return [];
  const at = Prisma.sql`COALESCE(r.started_at, r.created_at)`;
  const carriers =
    f.carrierIds.length > 0
      ? Prisma.sql`AND q.carrier_id = ANY(${f.carrierIds}::uuid[])`
      : Prisma.empty;
  return db.$queryRaw<QuoteRow[]>`
    WITH fetches AS (
      SELECT f.id, f.lab_run_id AS run_id, ${at} AS at,
             f.lab_address_id AS address_id, f.lab_parcel_id AS parcel_id
      FROM rate_fetches f
      JOIN rate_lab_runs r ON r.id = f.lab_run_id
      WHERE r.kind = 'SUITE'
        AND f.lab_address_id = ANY(${f.addressIds}::uuid[])
        AND f.lab_parcel_id = ANY(${f.parcelIds}::uuid[])
        ${f.includeFake ? Prisma.empty : Prisma.sql`AND NOT f.fake`}
        ${f.from ? Prisma.sql`AND ${at} >= ${new Date(f.from)}` : Prisma.empty}
        ${f.to ? Prisma.sql`AND ${at} < ${new Date(Date.parse(f.to) + DAY_MS)}` : Prisma.empty}
        ${f.until ? Prisma.sql`AND ${at} <= ${f.until}` : Prisma.empty}
        AND EXISTS (SELECT 1 FROM rate_quotes q WHERE q.fetch_id = f.id ${carriers})
    ), ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY address_id, parcel_id ORDER BY at DESC, run_id DESC
      ) AS rank
      FROM fetches
    )
    SELECT x.id AS "fetchId", x.run_id AS "runId", x.at,
           x.address_id AS "addressId", x.parcel_id AS "parcelId",
           q.carrier_id AS "carrierId", q.service_id AS "serviceId", q.service_name AS "serviceName",
           q.amount_cents AS "amountCents", q.delivery_days AS "deliveryDays", q.quote_only AS "quoteOnly"
    FROM ranked x
    JOIN rate_quotes q ON q.fetch_id = x.id ${carriers}
    ${f.latest ? Prisma.sql`WHERE x.rank <= ${f.latest}` : Prisma.empty}
    ORDER BY x.at, x.run_id, q.amount_cents, q.service_name`;
}

async function carrierNames(db: DbTx, rows: QuoteRow[]): Promise<Map<string, string>> {
  const carriers = await db.shippingCarrier.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.carrierId))] } },
    select: { id: true, name: true, label: true },
  });
  return new Map(carriers.map((c) => [c.id, c.label ?? c.name]));
}

function groupBy<K, T>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/** A fetch's cheapest quote: purchasable first, as carriers' pre-selection picks. */
function cheapest(quotes: QuoteRow[], carriers: Map<string, string>): LabTrendPrice {
  // Rows arrive by amount, so the first of each kind is its cheapest.
  const best = (quotes.find((q) => !q.quoteOnly) ?? quotes[0]) as QuoteRow;
  return {
    runId: best.runId,
    at: best.at,
    amountCents: best.amountCents,
    carrierName: carriers.get(best.carrierId) ?? "",
    serviceName: best.serviceName,
    quoteOnly: best.quoteOnly,
  };
}

/** One combination's rows as a line per carrier service, a point per suite run. */
function toSeries(
  rows: QuoteRow[],
  names: Map<string, string>,
  address: LabTrendSeries["address"],
  parcel: LabTrendSeries["parcel"],
): LabTrendSeries {
  const runs = [...groupBy(rows, (r) => r.runId).values()].map((quotes) => {
    const first = quotes[0] as QuoteRow;
    return { runId: first.runId, at: first.at };
  });
  const lines: LabTrendLine[] = [...groupBy(rows, (r) => r.serviceId)].map(
    ([serviceId, quotes]) => {
      const last = quotes.at(-1) as QuoteRow;
      // One point per run: rows come cheapest first within a run, so its first quote wins.
      const points = [...groupBy(quotes, (q) => q.runId).values()].map((perRun) => {
        const q = perRun[0] as QuoteRow;
        return {
          runId: q.runId,
          at: q.at,
          amountCents: q.amountCents,
          deliveryDays: q.deliveryDays,
        };
      });
      return {
        serviceId,
        carrierName: names.get(last.carrierId) ?? "",
        serviceName: last.serviceName,
        points,
      };
    },
  );
  lines.sort(
    (a, b) =>
      a.carrierName.localeCompare(b.carrierName) || a.serviceName.localeCompare(b.serviceName),
  );
  return { address, parcel, runs, lines };
}

const groupFilter = (groupIds: string[]) =>
  groupIds.length > 0 ? { groups: { some: { groupId: { in: groupIds } } } } : {};

/**
 * The heatmap (`ratelab.use`): a cell per active address × parcel in the chosen groups, with the
 * latest suite run's cheapest price and its change since the run before.
 */
export async function labTrendGrid(
  db: DbTx,
  actor: Actor,
  input: z.input<typeof LabTrendGridInput>,
): Promise<LabTrendGrid> {
  assertCan(actor, "ratelab.use");
  const filters = LabTrendGridInput.parse(input);
  const orderBy = [{ title: "asc" as const }, { id: "asc" as const }];
  const select = { id: true, title: true };
  const [addresses, parcels, carriers] = await Promise.all([
    db.rateLabAddress.findMany({
      where: { archivedAt: null, ...groupFilter(filters.addressGroupIds) },
      orderBy,
      select,
    }),
    db.rateLabParcel.findMany({
      where: { archivedAt: null, ...groupFilter(filters.parcelGroupIds) },
      orderBy,
      select,
    }),
    db.shippingCarrier.findMany({
      where: { rateQuotes: { some: { fetch: { source: "LAB" } } } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, label: true },
    }),
  ]);
  const rows = await loadQuotes(db, {
    ...filters,
    addressIds: addresses.map((a) => a.id),
    parcelIds: parcels.map((p) => p.id),
    latest: 2,
  });
  const names = await carrierNames(db, rows);
  const prices = new Map<string, LabTrendPrice[]>();
  for (const quotes of groupBy(rows, (r) => r.fetchId).values()) {
    const first = quotes[0] as QuoteRow;
    const key = `${first.addressId}|${first.parcelId}`;
    prices.set(key, [...(prices.get(key) ?? []), cheapest(quotes, names)]);
  }

  const cells: LabTrendCell[] = addresses.flatMap((address) =>
    parcels.map((parcel) => {
      // Oldest first, as the rows come.
      const runs = prices.get(`${address.id}|${parcel.id}`) ?? [];
      const latest = runs.at(-1) ?? null;
      const previous = runs.length > 1 ? (runs.at(-2) ?? null) : null;
      return {
        addressId: address.id,
        parcelId: parcel.id,
        latest,
        previous,
        change:
          latest && previous && previous.amountCents > 0
            ? (latest.amountCents - previous.amountCents) / previous.amountCents
            : null,
      };
    }),
  );
  return {
    addresses,
    parcels,
    cells,
    carriers: carriers
      .map((c) => ({ id: c.id, name: c.label ?? c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * One address × parcel over time (`ratelab.use`): a line per carrier service, a point per suite
 * run. Archived addresses and parcels keep their history.
 */
export async function labTrendSeries(
  db: DbTx,
  actor: Actor,
  input: z.input<typeof LabTrendSeriesInput>,
): Promise<LabTrendSeries> {
  assertCan(actor, "ratelab.use");
  const filters = LabTrendSeriesInput.parse(input);
  const select = { id: true, title: true, archivedAt: true };
  const [address, parcel] = await Promise.all([
    db.rateLabAddress.findUnique({ where: { id: filters.addressId }, select }),
    db.rateLabParcel.findUnique({ where: { id: filters.parcelId }, select }),
  ]);
  if (!address || !parcel) throw notFound();
  const rows = await loadQuotes(db, {
    ...filters,
    addressIds: [address.id],
    parcelIds: [parcel.id],
  });
  const names = await carrierNames(db, rows);

  const titled = (row: typeof address) => ({
    id: row.id,
    title: row.title,
    archived: row.archivedAt !== null,
  });
  return toSeries(rows, names, titled(address), titled(parcel));
}

/**
 * The run report's small charts (`ratelab.use`): each saved address × parcel of the run, with its
 * cheapest price in each of its last LAB_RUN_TREND_RUNS suite runs up to this run's time.
 */
export async function labRunTrends(
  db: DbTx,
  actor: Actor,
  input: z.input<typeof LabRunTrendsInput>,
): Promise<LabRunTrend[]> {
  assertCan(actor, "ratelab.use");
  const parsed = LabRunTrendsInput.safeParse(input);
  if (!parsed.success) throw notFound();
  const run = await db.rateLabRun.findUnique({
    where: { id: parsed.data.id },
    select: { startedAt: true, createdAt: true, fake: true },
  });
  if (!run) throw notFound();
  const fetches = await db.rateFetch.findMany({
    where: { labRunId: parsed.data.id, labAddressId: { not: null }, labParcelId: { not: null } },
    select: { labAddressId: true, labParcelId: true },
  });
  const keys = new Set(fetches.map((f) => `${f.labAddressId}|${f.labParcelId}`));
  const rows = (
    await loadQuotes(db, {
      addressIds: [...new Set(fetches.map((f) => f.labAddressId as string))],
      parcelIds: [...new Set(fetches.map((f) => f.labParcelId as string))],
      carrierIds: [],
      // A fake run's report charts its own (fake) prices.
      includeFake: run.fake,
      latest: LAB_RUN_TREND_RUNS,
      until: run.startedAt ?? run.createdAt,
    })
  ).filter((r) => keys.has(`${r.addressId}|${r.parcelId}`));
  const names = await carrierNames(db, rows);

  const trends = new Map<string, LabTrendPrice[]>();
  for (const quotes of groupBy(rows, (r) => r.fetchId).values()) {
    const first = quotes[0] as QuoteRow;
    const key = `${first.addressId}:${first.parcelId}`;
    trends.set(key, [...(trends.get(key) ?? []), cheapest(quotes, names)]);
  }
  return [...trends].map(([key, prices]) => ({ key, prices }));
}

/**
 * The Trends report (`ratelab.use`): the heatmap for these filters, and the series of each
 * combination with data, in grid order, up to LAB_TRENDS_REPORT_MAX.
 */
export async function labTrendsReport(
  db: DbTx,
  actor: Actor,
  input: z.input<typeof LabTrendGridInput>,
): Promise<LabTrendsReport> {
  const grid = await labTrendGrid(db, actor, input);
  const filters = LabTrendGridInput.parse(input);
  const withData = grid.cells.filter((c) => c.latest);
  const charted = withData.slice(0, LAB_TRENDS_REPORT_MAX);
  const rows = await loadQuotes(db, {
    ...filters,
    addressIds: [...new Set(charted.map((c) => c.addressId))],
    parcelIds: [...new Set(charted.map((c) => c.parcelId))],
  });
  const names = await carrierNames(db, rows);
  const byCombination = groupBy(rows, (r) => `${r.addressId}|${r.parcelId}`);
  const titled = (list: { id: string; title: string }[]) =>
    new Map(list.map((x) => [x.id, { ...x, archived: false }]));
  // The grid lists active addresses and parcels only.
  const addresses = titled(grid.addresses);
  const parcels = titled(grid.parcels);
  const series = charted.map((c) =>
    toSeries(
      byCombination.get(`${c.addressId}|${c.parcelId}`) ?? [],
      names,
      addresses.get(c.addressId) as LabTrendSeries["address"],
      parcels.get(c.parcelId) as LabTrendSeries["parcel"],
    ),
  );
  return { grid, series, omitted: withData.length - charted.length };
}
