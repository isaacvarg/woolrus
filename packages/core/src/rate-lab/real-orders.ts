import {
  type RateSelectionReason,
  type RealOrders,
  RealOrdersInput,
  type RealOrdersLaneWeek,
  type RealOrdersOrderCost,
  type RealOrdersPackage,
  type RealOrdersReason,
} from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import type { z } from "zod";
import { type Actor, assertCan } from "../permissions";
import { byName, DAY_MS, groupBy } from "./shared";

// Rate Lab's Real orders dashboard (SPEC-rate-lab "Real orders"): bought, not voided labels that
// link to their logged quote, compared with the other quotes of the same fetch. One query loads a
// row per label in the range; the filters and figures are plain sums over those rows, except label
// cost vs. charged, which costs each listed order with all its active labels.

const DEFAULT_DAYS = 30;
const OVER_MAX = 50;

/** Parsed dashboard filters. */
export type RealOrdersFilters = z.output<typeof RealOrdersInput>;

/** One active label in the range, with its bought quote and its fetch's cheapest. */
export type RealOrderRow = {
  labelId: string;
  purchasedAt: Date;
  reason: RateSelectionReason | null;
  /** What the label cost: the provider's cost, else the quoted amount. */
  costCents: number;
  quoteId: string;
  fetchId: string;
  amountCents: number;
  cheapest: boolean;
  /** Null when the fetch had no purchasable quote to mark. */
  cheapestCents: number | null;
  carrierId: string;
  serviceId: string;
  country: string;
  state: string | null;
  boxId: string | null;
  orderId: string;
  orderNumber: string;
  packageNumber: number;
  chargedCents: number;
};

export type RealOrderNames = {
  carriers: Map<string, string>;
  services: Map<string, { name: string; carrierId: string }>;
  boxes: Map<string, string>;
};

type Range = { from: Date; to: Date };

/** `from`/`to` are whole UTC days, `to` inclusive; without either, the last 30 days up to `now`. */
function range(input: { from?: string; to?: string }, now: Date): Range {
  const to = input.to ? new Date(Date.parse(input.to) + DAY_MS) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
  return { from, to };
}

async function loadRows(
  db: DbTx,
  { from, to }: Range,
  includeFake: boolean,
): Promise<RealOrderRow[]> {
  return db.$queryRaw<RealOrderRow[]>`
    SELECT l.id AS "labelId", l.purchased_at AS "purchasedAt", l.selection_reason AS "reason",
           COALESCE(l.cost_cents, l.quoted_amount_cents, q.amount_cents)::int AS "costCents",
           q.id AS "quoteId", q.fetch_id AS "fetchId", q.amount_cents AS "amountCents",
           q.cheapest, c.amount_cents AS "cheapestCents",
           q.carrier_id AS "carrierId", q.service_id AS "serviceId",
           f.dest_country AS "country", f.dest_state AS "state", f.box_id AS "boxId",
           o.id AS "orderId", o.number AS "orderNumber", p.number AS "packageNumber",
           o.shipping_charged_cents AS "chargedCents"
    FROM shipping_labels l
    JOIN rate_quotes q ON q.id = l.rate_quote_id
    JOIN rate_fetches f ON f.id = q.fetch_id
    JOIN packages p ON p.id = l.package_id
    JOIN orders o ON o.id = p.order_id
    LEFT JOIN rate_quotes c ON c.fetch_id = f.id AND c.cheapest
    WHERE l.status = 'ACTIVE'
      AND l.purchased_at >= ${from} AND l.purchased_at < ${to}
      ${includeFake ? Prisma.empty : Prisma.sql`AND NOT f.fake`}`;
}

async function loadNames(db: DbTx, rows: RealOrderRow[]): Promise<RealOrderNames> {
  const [carriers, services, boxes] = await Promise.all([
    db.shippingCarrier.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.carrierId))] } },
      select: { id: true, name: true, label: true },
    }),
    db.carrierService.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.serviceId))] } },
      select: { id: true, name: true, carrierId: true },
    }),
    db.box.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => (r.boxId ? [r.boxId] : [])))] } },
      select: { id: true, name: true },
    }),
  ]);
  return {
    carriers: new Map(carriers.map((c) => [c.id, c.label ?? c.name])),
    services: new Map(services.map((s) => [s.id, { name: s.name, carrierId: s.carrierId }])),
    boxes: new Map(boxes.map((b) => [b.id, b.name])),
  };
}

/** The middle value, or the rounded mean of the two middle ones. */
export function medianCents(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

/** The Monday (UTC) of the week `at` falls in. */
function weekOf(at: Date): string {
  const day = (at.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const overspend = (row: RealOrderRow) =>
  row.cheapest || row.cheapestCents === null ? 0 : Math.max(0, row.amountCents - row.cheapestCents);

function choice(rows: RealOrderRow[]): RealOrders["choice"] {
  const picked = rows.filter((r) => !r.cheapest);
  const byReason: RealOrdersReason[] = [...groupBy(picked, (r) => r.reason)].map(
    ([reason, group]) => ({
      reason,
      packages: group.length,
      overspendCents: sum(group.map(overspend)),
    }),
  );
  byReason.sort(
    (a, b) =>
      b.overspendCents - a.overspendCents || (a.reason ?? "~").localeCompare(b.reason ?? "~"),
  );
  return {
    packages: rows.length,
    onCheapest: rows.length - picked.length,
    notCheapest: picked.length,
    overspendCents: sum(picked.map(overspend)),
    byReason,
  };
}

const bySpend = (
  a: { spendCents: number; name: string },
  b: { spendCents: number; name: string },
) => b.spendCents - a.spendCents || a.name.localeCompare(b.name);

function laneCost(rows: RealOrderRow[]): RealOrdersLaneWeek[] {
  const lanes = groupBy(rows, (r) => `${r.country}|${r.state ?? ""}|${weekOf(r.purchasedAt)}`);
  return [...lanes.values()]
    .map((group) => {
      const first = group[0] as RealOrderRow;
      const costs = group.map((r) => r.costCents);
      return {
        country: first.country,
        state: first.state,
        week: weekOf(first.purchasedAt),
        packages: group.length,
        medianCents: medianCents(costs),
        meanCents: Math.round(sum(costs) / costs.length),
      };
    })
    .sort(
      (a, b) =>
        a.country.localeCompare(b.country) ||
        (a.state ?? "").localeCompare(b.state ?? "") ||
        a.week.localeCompare(b.week),
    );
}

/**
 * What each order's active package labels cost in all, whatever their date, link or filters: an
 * order's shipping charge pays for all of it, so comparing a part would read as profit.
 */
async function orderLabelCosts(db: DbTx, orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const totals = await db.$queryRaw<{ orderId: string; costCents: number }[]>`
    SELECT p.order_id AS "orderId",
           SUM(COALESCE(l.cost_cents, l.quoted_amount_cents, q.amount_cents, 0))::int AS "costCents"
    FROM packages p
    JOIN shipping_labels l ON l.package_id = p.id AND l.status = 'ACTIVE'
    LEFT JOIN rate_quotes q ON q.id = l.rate_quote_id
    WHERE p.order_id = ANY(${orderIds}::uuid[])
    GROUP BY p.order_id`;
  return new Map(totals.map((t) => [t.orderId, t.costCents]));
}

/** Per order the filters picked, all its label cost against what it charged for shipping. */
function costVsCharged(
  rows: RealOrderRow[],
  labelCosts: Map<string, number>,
): RealOrders["costVsCharged"] {
  const orders: RealOrdersOrderCost[] = [...groupBy(rows, (r) => r.orderId)].map(
    ([orderId, group]) => {
      const first = group[0] as RealOrderRow;
      return {
        orderId,
        number: first.orderNumber,
        costCents: labelCosts.get(orderId) ?? 0,
        chargedCents: first.chargedCents,
      };
    },
  );
  const over = orders
    .filter((o) => o.costCents > o.chargedCents)
    .sort((a, b) => b.costCents - b.chargedCents - (a.costCents - a.chargedCents));
  return {
    orders: orders.length,
    costCents: sum(orders.map((o) => o.costCents)),
    chargedCents: sum(orders.map((o) => o.chargedCents)),
    overCount: over.length,
    over: over.slice(0, OVER_MAX),
  };
}

async function alternatives(
  db: DbTx,
  rows: RealOrderRow[],
  names: RealOrderNames,
  limit: number,
): Promise<RealOrdersPackage[]> {
  const newest = [...rows]
    .sort(
      (a, b) =>
        b.purchasedAt.getTime() - a.purchasedAt.getTime() || b.labelId.localeCompare(a.labelId),
    )
    .slice(0, limit);
  const quotes = await db.rateQuote.findMany({
    where: { fetchId: { in: newest.map((r) => r.fetchId) } },
    include: { carrier: { select: { name: true, label: true } } },
    orderBy: [{ amountCents: "asc" }, { id: "asc" }],
  });
  const byFetch = groupBy(quotes, (q) => q.fetchId);
  return newest.map((row) => ({
    labelId: row.labelId,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    packageNumber: row.packageNumber,
    purchasedAt: row.purchasedAt,
    country: row.country,
    state: row.state,
    reason: row.reason,
    quotes: (byFetch.get(row.fetchId) ?? []).map((q) => ({
      id: q.id,
      carrierName: names.carriers.get(q.carrierId) ?? q.carrier.label ?? q.carrier.name,
      serviceName: q.serviceName,
      amountCents: q.amountCents,
      deliveryDays: q.deliveryDays,
      quoteOnly: q.quoteOnly,
      cheapest: q.cheapest,
      bought: q.id === row.quoteId,
    })),
  }));
}

function options(rows: RealOrderRow[], names: RealOrderNames): RealOrders["options"] {
  const lanes = new Map(
    rows.flatMap((r) =>
      r.state ? [[`${r.country}|${r.state}`, { country: r.country, state: r.state }]] : [],
    ),
  );
  return {
    carriers: [...names.carriers].map(([id, name]) => ({ id, name })).sort(byName),
    services: [...names.services]
      .map(([id, s]) => ({ id, name: s.name, carrierId: s.carrierId }))
      .sort(byName),
    countries: [...new Set(rows.map((r) => r.country))].sort(),
    states: [...lanes.values()].sort(
      (a, b) => a.country.localeCompare(b.country) || a.state.localeCompare(b.state),
    ),
    boxes: [...names.boxes].map(([id, name]) => ({ id, name })).sort(byName),
  };
}

/**
 * The labels the dashboard reads, before (`all`) and after (`rows`) its filters, with their names.
 * Callers check `report.read`; the CSV export shares it so both read the same packages.
 */
export async function realOrderRows(db: DbTx, filters: RealOrdersFilters, now: Date) {
  const { from, to } = range(filters, now);
  const all = await loadRows(db, { from, to }, filters.includeFake);
  const names = await loadNames(db, all);
  const rows = all.filter(
    (r) =>
      (!filters.carrierId || r.carrierId === filters.carrierId) &&
      (!filters.serviceId || r.serviceId === filters.serviceId) &&
      (!filters.country || r.country === filters.country) &&
      (!filters.state || r.state === filters.state) &&
      (!filters.boxId || r.boxId === filters.boxId),
  );
  return { from, to, all, rows, names };
}

/**
 * The Real orders dashboard (`report.read`): what QA chose against the cheapest, carrier and service
 * share, lane cost per week, label cost against shipping charged, and each package's alternatives.
 */
export async function realOrders(
  db: DbTx,
  actor: Actor,
  input: z.input<typeof RealOrdersInput>,
  { now = new Date() }: { now?: Date } = {},
): Promise<RealOrders> {
  // `report.read` alone (SPEC-rate-lab "Permissions"), as the CSV export and the PDF report check it.
  assertCan(actor, "report.read");
  const filters = RealOrdersInput.parse(input);
  const { from, to, all, rows, names } = await realOrderRows(db, filters, now);
  const share = <K extends "carrierId" | "serviceId">(key: K) =>
    [...groupBy(rows, (r) => r[key])].map(([id, group]) => ({
      id,
      packages: group.length,
      spendCents: sum(group.map((r) => r.costCents)),
    }));

  return {
    from,
    to,
    choice: choice(rows),
    byCarrier: share("carrierId")
      .map(({ id, ...counts }) => ({
        carrierId: id,
        name: names.carriers.get(id) ?? "",
        ...counts,
      }))
      .sort(bySpend),
    byService: share("serviceId")
      .map(({ id, ...counts }) => {
        const service = names.services.get(id);
        return {
          serviceId: id,
          carrierName: (service && names.carriers.get(service.carrierId)) ?? "",
          name: service?.name ?? "",
          ...counts,
        };
      })
      .sort(bySpend),
    laneCost: laneCost(rows),
    costVsCharged: costVsCharged(
      rows,
      await orderLabelCosts(db, [...new Set(rows.map((r) => r.orderId))]),
    ),
    alternatives: {
      total: rows.length,
      packages: await alternatives(db, rows, names, filters.alternativesLimit),
    },
    options: options(all, names),
  };
}
