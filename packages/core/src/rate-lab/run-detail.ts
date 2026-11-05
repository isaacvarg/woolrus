import {
  type LabCombination,
  type LabQuote,
  type LabRunDetail,
  LabRunSelection,
  RateError,
} from "@woolrus/contracts";
import { type Db, Prisma, type RateQuote } from "@woolrus/db";
import { z } from "zod";
import { compareRates } from "../carriers/compare";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { type ComparedCombination, runInsights } from "./insights";
import { labRunInclude, labRunRows } from "./runs";
import { groupBy } from "./shared";

// A run's page (SPEC-rate-lab "Run detail"): every quote by address × parcel, and the insights,
// with each service's price compared against the most recent earlier suite run that had it.

const Input = z.object({ id: z.uuid() });
const Errors = z.array(RateError).catch([]);

const key = (fetch: { id: string; labAddressId: string | null; labParcelId: string | null }) =>
  fetch.labAddressId && fetch.labParcelId ? `${fetch.labAddressId}:${fetch.labParcelId}` : fetch.id;

type Compared = {
  fetchId: string;
  addressId: string;
  parcelId: string;
  runId: string;
  createdAt: Date;
};

/** A saved address × parcel of this run, and whether its fetch used a fake provider. */
type Pair = { addressId: string; parcelId: string; fake: boolean };

/**
 * The earlier fetches a combination is compared with: `SUITE` runs created before this one, for
 * the same address × parcel, with the same fake flag (SPEC-rate-history decision 6). One-off runs
 * never count (decision 12). Both queries below order them the same way, newest first, so the
 * last run's quotes are exactly the per-service rows from its fetch.
 */
function earlierSuiteFetches(run: { id: string; createdAt: Date }, pairs: Pair[]) {
  return Prisma.sql`
    JOIN rate_lab_runs r ON r.id = f.lab_run_id
    WHERE r.kind = 'SUITE'
      AND (r.created_at, r.id) < (${run.createdAt}, ${run.id}::uuid)
      AND (f.lab_address_id, f.lab_parcel_id, f.fake) IN (
        SELECT * FROM unnest(
          ${pairs.map((p) => p.addressId)}::uuid[],
          ${pairs.map((p) => p.parcelId)}::uuid[],
          ${pairs.map((p) => p.fake)}::boolean[]
        )
      )`;
}

const newestFirst = Prisma.sql`r.created_at DESC, r.id DESC, f.fetched_at DESC, f.id DESC`;

/**
 * For each saved address × parcel, the latest earlier fetch that got quotes for it: what the page
 * says it compared with, and what MISSING is measured on. An earlier run whose combination failed
 * outright doesn't count: with nothing to compare, every service would read as missing.
 */
function lastFetches(db: Db, run: { id: string; createdAt: Date }, pairs: Pair[]) {
  if (pairs.length === 0) return Promise.resolve([] as Compared[]);
  return db.$queryRaw<Compared[]>`
    SELECT DISTINCT ON (f.lab_address_id, f.lab_parcel_id)
           f.id AS "fetchId", f.lab_address_id AS "addressId", f.lab_parcel_id AS "parcelId",
           r.id AS "runId", r.created_at AS "createdAt"
    FROM rate_fetches f
    ${earlierSuiteFetches(run, pairs)}
      AND EXISTS (SELECT 1 FROM rate_quotes q WHERE q.fetch_id = f.id)
    ORDER BY f.lab_address_id, f.lab_parcel_id, ${newestFirst}
  `;
}

type ComparedQuote = QuoteRow & { addressId: string; parcelId: string };

/**
 * For each saved address × parcel × carrier service, its cheapest quote in the latest earlier
 * fetch that had that service, so a service a partial run missed is compared with the run before.
 */
function latestByService(db: Db, run: { id: string; createdAt: Date }, pairs: Pair[]) {
  if (pairs.length === 0) return Promise.resolve([] as ComparedQuote[]);
  return db.$queryRaw<ComparedQuote[]>`
    SELECT DISTINCT ON (f.lab_address_id, f.lab_parcel_id, q.service_id)
           q.id, q.fetch_id AS "fetchId", q.provider, q.carrier_id AS "carrierId",
           q.service_id AS "serviceId", q.service_code AS "serviceCode",
           q.service_name AS "serviceName", q.amount_cents AS "amountCents", q.currency,
           q.delivery_days AS "deliveryDays", q.guaranteed, q.quote_only AS "quoteOnly", q.fake,
           f.lab_address_id AS "addressId", f.lab_parcel_id AS "parcelId"
    FROM rate_quotes q
    JOIN rate_fetches f ON f.id = q.fetch_id
    ${earlierSuiteFetches(run, pairs)}
    ORDER BY f.lab_address_id, f.lab_parcel_id, q.service_id, ${newestFirst},
             q.amount_cents, q.id
  `;
}

const quoteSelect = {
  id: true,
  fetchId: true,
  provider: true,
  carrierId: true,
  serviceId: true,
  serviceCode: true,
  serviceName: true,
  amountCents: true,
  currency: true,
  deliveryDays: true,
  guaranteed: true,
  quoteOnly: true,
  fake: true,
} as const;

type QuoteRow = Pick<RateQuote, keyof typeof quoteSelect>;

/** One run with its quotes and insights; `ratelab.use`. */
export async function getLabRun(
  db: Db,
  actor: Actor,
  input: { id: string },
): Promise<LabRunDetail> {
  assertCan(actor, "ratelab.use");
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw notFound();
  const run = await db.rateLabRun.findUnique({
    where: { id: parsed.data.id },
    include: labRunInclude,
  });
  if (!run) throw notFound();

  const fetches = await db.rateFetch.findMany({
    where: { labRunId: run.id },
    select: {
      id: true,
      labAddressId: true,
      labParcelId: true,
      destCountry: true,
      destState: true,
      providerErrors: true,
      fake: true,
      labAddress: { select: { id: true, title: true } },
      labParcel: { select: { id: true, title: true } },
      quotes: { select: quoteSelect },
    },
  });
  const pairs: Pair[] = fetches.flatMap((f) =>
    f.labAddressId && f.labParcelId
      ? [{ addressId: f.labAddressId, parcelId: f.labParcelId, fake: f.fake }]
      : [],
  );
  const [compared, previousQuotes] = await Promise.all([
    lastFetches(db, run, pairs),
    latestByService(db, run, pairs),
  ]);

  const carrierIds = [
    ...new Set([...fetches.flatMap((f) => f.quotes), ...previousQuotes].map((q) => q.carrierId)),
  ];
  const carriers = new Map(
    (
      await db.shippingCarrier.findMany({
        where: { id: { in: carrierIds } },
        select: { id: true, name: true, label: true },
      })
    ).map((c) => [c.id, c.label ?? c.name]),
  );
  const toQuote = ({ fetchId: _, ...q }: QuoteRow): LabQuote => ({
    ...q,
    carrierName: carriers.get(q.carrierId) ?? "",
  });

  const comparedByKey = new Map(compared.map((c) => [`${c.addressId}:${c.parcelId}`, c]));
  const combinations: LabCombination[] = fetches
    .map((fetch) => {
      const k = key(fetch);
      const before = comparedByKey.get(k);
      return {
        key: k,
        fetchId: fetch.id,
        address: fetch.labAddress,
        parcel: fetch.labParcel,
        lane: { country: fetch.destCountry, state: fetch.destState },
        quotes: fetch.quotes.map(toQuote).sort(compareRates),
        errors: Errors.parse(fetch.providerErrors),
        comparedWith: before ? { runId: before.runId, createdAt: before.createdAt } : null,
      };
    })
    .sort(
      (a, b) =>
        (a.address?.title ?? "").localeCompare(b.address?.title ?? "") ||
        (a.parcel?.title ?? "").localeCompare(b.parcel?.title ?? "") ||
        a.fetchId.localeCompare(b.fetchId),
    );

  const previousByKey = groupBy(previousQuotes, (q) => `${q.addressId}:${q.parcelId}`);
  const previous = new Map<string, ComparedCombination>(
    [...comparedByKey].map(([k, c]) => {
      const rows = previousByKey.get(k) ?? [];
      const byService = rows.map(({ addressId: _a, parcelId: _p, ...q }) => toQuote(q));
      // Every service of the last fetch has its latest row in that fetch (both queries order
      // fetches the same way), so these are its quotes, one per service.
      const lastRun = byService.filter((_, i) => rows[i]?.fetchId === c.fetchId);
      return [k, { lastRun, byService }];
    }),
  );

  const [row] = await labRunRows(db, [run]);
  return {
    run: row as LabRunDetail["run"],
    selection: LabRunSelection.catch(LabRunSelection.parse({})).parse(run.selection),
    combinations,
    insights: runInsights(combinations, previous),
  };
}
