import {
  type LabCombination,
  type LabQuote,
  type LabRunDetail,
  LabRunSelection,
  RateError,
} from "@woolrus/contracts";
import type { Db, RateQuote } from "@woolrus/db";
import { z } from "zod";
import { compareRates } from "../carriers/compare";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { type InsightCombination, runInsights } from "./insights";
import { labRunInclude, labRunRows } from "./runs";

// A run's page (SPEC-rate-lab "Run detail"): every quote by address × parcel, and the insights,
// with prices compared against the most recent earlier suite run of each combination.

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

/**
 * For each saved address × parcel, the latest fetch of an earlier `SUITE` run that got quotes for
 * it. One-off runs never count (decision 12), and neither does an earlier run whose combination
 * failed outright: with nothing to compare, every service would read as new.
 */
function comparedFetches(
  db: Db,
  run: { id: string; createdAt: Date },
  pairs: { addressId: string; parcelId: string }[],
) {
  if (pairs.length === 0) return Promise.resolve([] as Compared[]);
  const addressIds = pairs.map((p) => p.addressId);
  const parcelIds = pairs.map((p) => p.parcelId);
  return db.$queryRaw<Compared[]>`
    SELECT DISTINCT ON (f.lab_address_id, f.lab_parcel_id)
           f.id AS "fetchId", f.lab_address_id AS "addressId", f.lab_parcel_id AS "parcelId",
           r.id AS "runId", r.created_at AS "createdAt"
    FROM rate_fetches f
    JOIN rate_lab_runs r ON r.id = f.lab_run_id
    WHERE r.kind = 'SUITE'
      AND (r.created_at, r.id) < (${run.createdAt}, ${run.id}::uuid)
      AND (f.lab_address_id, f.lab_parcel_id) IN (
        SELECT * FROM unnest(${addressIds}::uuid[], ${parcelIds}::uuid[])
      )
      AND EXISTS (SELECT 1 FROM rate_quotes q WHERE q.fetch_id = f.id)
    ORDER BY f.lab_address_id, f.lab_parcel_id, r.created_at DESC, r.id DESC, f.fetched_at DESC
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
      labAddress: { select: { id: true, title: true } },
      labParcel: { select: { id: true, title: true } },
      quotes: { select: quoteSelect },
    },
  });
  const pairs = fetches.flatMap((f) =>
    f.labAddressId && f.labParcelId ? [{ addressId: f.labAddressId, parcelId: f.labParcelId }] : [],
  );
  const compared = await comparedFetches(db, run, pairs);
  const previousQuotes: QuoteRow[] =
    compared.length === 0
      ? []
      : await db.rateQuote.findMany({
          where: { fetchId: { in: compared.map((c) => c.fetchId) } },
          select: quoteSelect,
        });

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

  const quotesByFetch = new Map<string, LabQuote[]>();
  for (const quote of previousQuotes) {
    const list = quotesByFetch.get(quote.fetchId) ?? [];
    list.push(toQuote(quote));
    quotesByFetch.set(quote.fetchId, list);
  }
  const previous = new Map<string, InsightCombination>(
    [...comparedByKey].map(([k, c]) => [
      k,
      { key: k, quotes: quotesByFetch.get(c.fetchId) ?? [], errors: [] },
    ]),
  );

  const [row] = await labRunRows(db, [run]);
  return {
    run: row as LabRunDetail["run"],
    selection: LabRunSelection.catch(LabRunSelection.parse({})).parse(run.selection),
    combinations,
    insights: runInsights(combinations, previous),
  };
}
