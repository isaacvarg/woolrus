import type {
  LabCarrierWin,
  LabPick,
  LabPriceMove,
  LabProviderFailures,
  LabQuote,
  LabRunInsights,
  RateError,
} from "@woolrus/contracts";
import { providerIds } from "../adapters/shipping/provider";
import { compareRates } from "../carriers/compare";

// What a run found (SPEC-rate-lab "Insights"). Pure: the run detail loads the quotes and the
// compared runs, this only reads them.

/** A price change this big or bigger, either way, is worth a look. */
export const PRICE_MOVE_PCT = 10;

export type InsightCombination = { key: string; quotes: LabQuote[]; errors: RateError[] };

/** Purchasable quotes when there are any, else every quote, marked as quote-only. */
function pool(quotes: LabQuote[]) {
  const purchasable = quotes.filter((q) => !q.quoteOnly);
  return purchasable.length > 0
    ? { quotes: purchasable, quoteOnly: false }
    : { quotes, quoteOnly: quotes.length > 0 };
}

/** Cheapest by carriers' rule; fastest by fewest known delivery days, then that same rule. */
function pick({ key, quotes }: InsightCombination): LabPick {
  const { quotes: candidates, quoteOnly } = pool(quotes);
  const cheapest = [...candidates].sort(compareRates)[0];
  const fastest = candidates
    .filter((q) => q.deliveryDays !== null)
    .sort((a, b) => (a.deliveryDays ?? 0) - (b.deliveryDays ?? 0) || compareRates(a, b))[0];
  return {
    key,
    cheapestId: cheapest?.id ?? null,
    cheapestQuoteOnly: cheapest ? quoteOnly : false,
    fastestId: fastest?.id ?? null,
    fastestQuoteOnly: fastest ? quoteOnly : false,
    failed: quotes.length === 0,
  };
}

/** A combination's lowest price per carrier service. */
function byService(quotes: LabQuote[]) {
  const found = new Map<string, LabQuote>();
  for (const quote of quotes) {
    const seen = found.get(quote.serviceId);
    if (!seen || quote.amountCents < seen.amountCents) found.set(quote.serviceId, quote);
  }
  return found;
}

const service = (q: LabQuote) => ({
  carrierId: q.carrierId,
  carrierName: q.carrierName,
  serviceId: q.serviceId,
  serviceName: q.serviceName,
});

/**
 * What a combination is compared with: earlier `SUITE` runs whose fetch had the same fake flag
 * (SPEC-rate-history decision 6).
 */
export type ComparedCombination = {
  /** The quotes of the most recent earlier run with the combination; MISSING is measured on it. */
  lastRun: LabQuote[];
  /**
   * Each service's quotes in the most recent earlier run that had that service, so a service a
   * partial run missed is compared with the run before it rather than read as new.
   */
  byService: LabQuote[];
};

/**
 * Moves of `PRICE_MOVE_PCT` or more, and services that came or went. A move from a free price has
 * no percentage (`changePct: null`).
 */
function moves(current: InsightCombination, previous: ComparedCombination): LabPriceMove[] {
  const now = byService(current.quotes);
  const before = byService(previous.byService);
  const last = byService(previous.lastRun);
  const changed: LabPriceMove[] = [];
  const added: LabPriceMove[] = [];
  for (const [serviceId, quote] of now) {
    const was = before.get(serviceId);
    const base = {
      combinationKey: current.key,
      ...service(quote),
      currentCents: quote.amountCents,
    };
    if (!was) {
      added.push({ ...base, kind: "NEW", previousCents: null, changePct: null });
      continue;
    }
    const delta = quote.amountCents - was.amountCents;
    // In whole cents, so 10% is flagged and 9.9% isn't, with no rounding in between.
    if (delta !== 0 && Math.abs(delta) * 100 >= PRICE_MOVE_PCT * was.amountCents) {
      changed.push({
        ...base,
        kind: "CHANGED",
        previousCents: was.amountCents,
        changePct: was.amountCents > 0 ? (delta / was.amountCents) * 100 : null,
      });
    }
  }
  const missing: LabPriceMove[] = [...last]
    .filter(([serviceId]) => !now.has(serviceId))
    .map(([, was]) => ({
      combinationKey: current.key,
      kind: "MISSING",
      ...service(was),
      previousCents: was.amountCents,
      currentCents: null,
      changePct: null,
    }));
  return [...changed, ...added, ...missing];
}

/**
 * The run page's insight cards: each combination's cheapest and fastest, price moves against
 * `previous` (by combination key), how often each carrier service was cheapest, and failures per
 * provider.
 */
export function runInsights(
  combinations: readonly InsightCombination[],
  previous: ReadonlyMap<string, ComparedCombination>,
): LabRunInsights {
  const picks = combinations.map(pick);

  const wins = new Map<string, LabCarrierWin>();
  combinations.forEach((combination, i) => {
    const winner = combination.quotes.find((q) => q.id === picks[i]?.cheapestId);
    if (!winner) return;
    const seen = wins.get(winner.serviceId) ?? { ...service(winner), wins: 0 };
    wins.set(winner.serviceId, { ...seen, wins: seen.wins + 1 });
  });

  const failures = new Map<string | null, LabProviderFailures>();
  for (const { key, errors } of combinations) {
    for (const { provider, messageKey, params } of errors) {
      const seen = failures.get(provider) ?? { provider, count: 0, errors: [] };
      seen.count++;
      seen.errors.push({ combinationKey: key, messageKey, ...(params && { params }) });
      failures.set(provider, seen);
    }
  }
  // Providers in their usual order; errors before any provider was called last.
  const rank = (p: string | null) =>
    p === null ? providerIds.length : providerIds.indexOf(p as (typeof providerIds)[number]);

  return {
    picks,
    moves: combinations.flatMap((c) => {
      const before = previous.get(c.key);
      return before ? moves(c, before) : [];
    }),
    carrierWins: [...wins.values()].sort(
      (a, b) =>
        b.wins - a.wins ||
        a.carrierName.localeCompare(b.carrierName) ||
        a.serviceName.localeCompare(b.serviceName),
    ),
    failures: [...failures.values()].sort((a, b) => rank(a.provider) - rank(b.provider)),
  };
}
