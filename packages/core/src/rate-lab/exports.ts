import { RealOrdersInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import type { z } from "zod";
import type { CsvCell } from "../csv";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { realOrderRows } from "./real-orders";
import { getLabRun } from "./run-detail";
import { groupBy } from "./shared";

// Rate Lab's CSV exports (SPEC-rate-lab "Exports", FR-REP-04): one row per quote, for a run and
// for the Real orders dashboard's filters. The caller streams `rows` through `csvStream`.

export type CsvExport = {
  filename: string;
  header: readonly string[];
  rows: AsyncIterable<readonly CsvCell[]>;
};

/** Real orders' quotes load this many packages at a time while the file streams. */
const PACKAGE_BATCH = 200;

const QUOTE_COLUMNS = [
  "Provider",
  "Carrier",
  "Service",
  "Amount",
  "Currency",
  "Delivery days",
  "Cheapest",
  "Bought",
  "Reason",
] as const;

export const LAB_RUN_CSV_HEADER = ["Run", "Address", "Parcel", ...QUOTE_COLUMNS] as const;
export const REAL_ORDERS_CSV_HEADER = [
  "Order",
  "Package",
  "Purchased at",
  "Lane",
  "Parcel",
  ...QUOTE_COLUMNS,
] as const;

const yesNo = (value: boolean) => (value ? "yes" : "no");
const amount = (cents: number) => cents / 100;
const laneName = (country: string, state: string | null) =>
  state ? `${country}-${state}` : country;
const day = (at: Date) => at.toISOString().slice(0, 10);

/** A run's quotes, combination by combination, cheapest first; `ratelab.use`. */
export async function labRunCsv(db: Db, actor: Actor, input: { id: string }): Promise<CsvExport> {
  const detail = await getLabRun(db, actor, input);
  const cheapest = new Set(detail.insights.picks.flatMap((p) => p.cheapestId ?? []));
  async function* rows() {
    for (const c of detail.combinations) {
      const address = c.address?.title ?? laneName(c.lane.country, c.lane.state);
      for (const q of c.quotes) {
        yield [
          detail.run.id,
          address,
          c.parcel?.title ?? null,
          q.provider,
          q.carrierName,
          q.serviceName,
          amount(q.amountCents),
          q.currency,
          q.deliveryDays,
          yesNo(cheapest.has(q.id)),
          // Rate Lab never buys a label.
          null,
          null,
        ];
      }
    }
  }
  return {
    filename: `rate-lab-run-${day(detail.run.createdAt)}-${detail.run.id.slice(0, 8)}.csv`,
    header: LAB_RUN_CSV_HEADER,
    rows: rows(),
  };
}

/**
 * Every quote of each package the Real orders dashboard reads with these filters, newest package
 * first; `report.read`. QA's reason is on the bought quote's row.
 */
export async function realOrdersCsv(
  db: DbTx,
  actor: Actor,
  input: z.input<typeof RealOrdersInput>,
  { now = new Date() }: { now?: Date } = {},
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const parsed = RealOrdersInput.safeParse(input);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "errors.validation");
  const { from, to, rows: labels, names } = await realOrderRows(db, parsed.data, now);
  const newest = [...labels].sort(
    (a, b) =>
      b.purchasedAt.getTime() - a.purchasedAt.getTime() || b.labelId.localeCompare(a.labelId),
  );

  async function* rows() {
    for (let i = 0; i < newest.length; i += PACKAGE_BATCH) {
      const batch = newest.slice(i, i + PACKAGE_BATCH);
      const quotes = await db.rateQuote.findMany({
        where: { fetchId: { in: batch.map((r) => r.fetchId) } },
        select: {
          id: true,
          fetchId: true,
          provider: true,
          carrierId: true,
          serviceName: true,
          amountCents: true,
          currency: true,
          deliveryDays: true,
          cheapest: true,
          carrier: { select: { name: true, label: true } },
        },
        orderBy: [{ amountCents: "asc" }, { id: "asc" }],
      });
      const byFetch = groupBy(quotes, (q) => q.fetchId);
      for (const label of batch) {
        for (const q of byFetch.get(label.fetchId) ?? []) {
          const bought = q.id === label.quoteId;
          yield [
            label.orderNumber,
            label.packageNumber,
            label.purchasedAt.toISOString(),
            laneName(label.country, label.state),
            label.boxId ? (names.boxes.get(label.boxId) ?? null) : null,
            q.provider,
            names.carriers.get(q.carrierId) ?? q.carrier.label ?? q.carrier.name,
            q.serviceName,
            amount(q.amountCents),
            q.currency,
            q.deliveryDays,
            yesNo(q.cheapest),
            yesNo(bought),
            bought ? label.reason : null,
          ];
        }
      }
    }
  }
  const last = new Date(to.getTime() - 1);
  return {
    filename: `real-orders-${day(from)}-${day(last)}.csv`,
    header: REAL_ORDERS_CSV_HEADER,
    rows: rows(),
  };
}
