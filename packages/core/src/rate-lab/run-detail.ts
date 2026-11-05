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

/** A saved address × parcel of this run, and whether its fetch used a fake provider. */
type Pair = { addressId: string; parcelId: string; fake: boolean };

/**
 * The earlier fetches a combination is compared with: from `SUITE` runs created before this one,
 * for the same address × parcel, with the same fake flag (SPEC-rate-history decision 6). One-off
 * runs never count (decision 12). `alias` is the `unnest` row of the pair being compared.
 *
 * Each query below is a `LATERAL ... LIMIT 1` per pair (or pair × service) that walks the pair's
 * fetches newest first down the `(lab_address_id, lab_parcel_id, fetched_at)` index and stops at
 * the first match, so the page costs the same however much history is kept: rate history is never
 * pruned, and the live run page reloads every few seconds. Newest by `fetched_at` is newest by
 * run: one suite run is active at a time and logs its last combination before it ends, so every
 * fetch of an earlier run predates the next one. Only a run failed as stalled whose worker still
 * logs a late combination breaks that, and that late fetch is then the pair's newest quote anyway.
 */
function earlierSuiteFetches(run: { id: string; createdAt: Date }, alias: string) {
  const pair = Prisma.raw(alias);
  return Prisma.sql`
    FROM rate_fetches f
    JOIN rate_lab_runs r ON r.id = f.lab_run_id
    WHERE f.lab_address_id = ${pair}.address_id AND f.lab_parcel_id = ${pair}.parcel_id
      AND f.fake = ${pair}.fake
      AND r.kind = 'SUITE'
      AND (r.created_at, r.id) < (${run.createdAt}, ${run.id}::uuid)
    `;
}

const newestFirst = Prisma.sql`f.fetched_at DESC, f.id DESC`;

const quoteColumns = Prisma.sql`
  q.id, q.fetch_id AS "fetchId", q.provider, q.carrier_id AS "carrierId",
  q.service_id AS "serviceId", q.service_code AS "serviceCode",
  q.service_name AS "serviceName", q.amount_cents AS "amountCents", q.currency,
  q.delivery_days AS "deliveryDays", q.guaranteed, q.quote_only AS "quoteOnly", q.fake`;

type ComparedQuote = QuoteRow & { addressId: string; parcelId: string };
type LastRunQuote = ComparedQuote & { runId: string; createdAt: Date };

/**
 * For each saved address × parcel, the quotes of the latest earlier fetch that got any: the run
 * the page says it compared with, and what MISSING is measured on. An earlier run whose
 * combination failed outright doesn't count: with nothing to compare, every service would read as
 * missing.
 */
function lastRunQuotes(db: Db, run: { id: string; createdAt: Date }, pairs: Pair[]) {
  if (pairs.length === 0) return Promise.resolve([] as LastRunQuote[]);
  return db.$queryRaw<LastRunQuote[]>`
    SELECT ${quoteColumns}, p.address_id AS "addressId", p.parcel_id AS "parcelId",
           last.run_id AS "runId", last.created_at AS "createdAt"
    FROM unnest(
      ${pairs.map((p) => p.addressId)}::uuid[],
      ${pairs.map((p) => p.parcelId)}::uuid[],
      ${pairs.map((p) => p.fake)}::boolean[]
    ) AS p(address_id, parcel_id, fake)
    CROSS JOIN LATERAL (
      SELECT f.id AS fetch_id, r.id AS run_id, r.created_at
      ${earlierSuiteFetches(run, "p")}
        AND EXISTS (SELECT 1 FROM rate_quotes any_quote WHERE any_quote.fetch_id = f.id)
      ORDER BY ${newestFirst}
      LIMIT 1
    ) last
    JOIN rate_quotes q ON q.fetch_id = last.fetch_id
  `;
}

/**
 * For each of `services` (a carrier service this run quoted a saved address × parcel with that
 * the last fetch lacks), its cheapest quote in the latest earlier fetch that had it, so a service
 * a partial run missed is compared with the run before rather than read as new.
 */
function latestByService(
  db: Db,
  run: { id: string; createdAt: Date },
  services: (Pair & { serviceId: string })[],
) {
  if (services.length === 0) return Promise.resolve([] as ComparedQuote[]);
  return db.$queryRaw<ComparedQuote[]>`
    SELECT latest.*, s.address_id AS "addressId", s.parcel_id AS "parcelId"
    FROM unnest(
      ${services.map((s) => s.addressId)}::uuid[],
      ${services.map((s) => s.parcelId)}::uuid[],
      ${services.map((s) => s.fake)}::boolean[],
      ${services.map((s) => s.serviceId)}::uuid[]
    ) AS s(address_id, parcel_id, fake, service_id)
    CROSS JOIN LATERAL (
      SELECT f.id AS fetch_id
      ${earlierSuiteFetches(run, "s")}
        AND EXISTS (
          SELECT 1 FROM rate_quotes has
          WHERE has.fetch_id = f.id AND has.service_id = s.service_id
        )
      ORDER BY ${newestFirst}
      LIMIT 1
    ) found
    CROSS JOIN LATERAL (
      SELECT ${quoteColumns}
      FROM rate_quotes q
      WHERE q.fetch_id = found.fetch_id AND q.service_id = s.service_id
      ORDER BY q.amount_cents, q.id
      LIMIT 1
    ) latest
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
  const saved = fetches.flatMap((f) =>
    f.labAddressId && f.labParcelId
      ? [{ pair: { addressId: f.labAddressId, parcelId: f.labParcelId, fake: f.fake }, fetch: f }]
      : [],
  );
  const pairKey = (q: { addressId: string; parcelId: string }) => `${q.addressId}:${q.parcelId}`;
  const lastQuotes = await lastRunQuotes(
    db,
    run,
    saved.map(({ pair }) => pair),
  );
  const lastByKey = groupBy(lastQuotes, pairKey);
  // The last fetch is the latest for every service it has; only the ones it lacks (a partial run,
  // or a service that's new) look further back.
  const services = saved.flatMap(({ pair, fetch }) => {
    const last = new Set(lastByKey.get(pairKey(pair))?.map((q) => q.serviceId));
    return [...new Set(fetch.quotes.map((q) => q.serviceId))]
      .filter((serviceId) => !last.has(serviceId))
      .map((serviceId) => ({ ...pair, serviceId }));
  });
  const previousQuotes = await latestByService(db, run, services);

  const carrierIds = [
    ...new Set(
      [...fetches.flatMap((f) => f.quotes), ...lastQuotes, ...previousQuotes].map(
        (q) => q.carrierId,
      ),
    ),
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

  const combinations: LabCombination[] = fetches
    .map((fetch) => {
      const k = key(fetch);
      const before = lastByKey.get(k)?.[0];
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

  const previousByKey = groupBy(previousQuotes, pairKey);
  const previous = new Map<string, ComparedCombination>(
    [...lastByKey].map(([k, rows]) => {
      const lastRun = rows.map(({ addressId: _a, parcelId: _p, runId: _r, createdAt: _c, ...q }) =>
        toQuote(q),
      );
      const older = (previousByKey.get(k) ?? []).map(({ addressId: _a, parcelId: _p, ...q }) =>
        toQuote(q),
      );
      return [k, { lastRun, byService: [...lastRun, ...older] }];
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
