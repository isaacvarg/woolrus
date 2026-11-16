import type { BatchSuggestion, BatchSuggestionShared } from "@woolrus/contracts";

// Suggested batches (SPEC-picking A1, "Suggested batches"). Pure and deterministic, so two pickers
// looking at the same queue see the same cards. The oldest or most urgent order left always starts
// a suggestion; overlap only decides which orders ride along with it (A1 decision 1).

/** One pickable line: its shelf key (`shelfKey`) and active quantity. */
export type SuggestionLine = { key: string; name: string; quantity: number };

export type SuggestionOrder = {
  id: string;
  number: string;
  version: number;
  orderedAt: Date;
  lines: SuggestionLine[];
};

export type SuggestionLimits = {
  /** `Settings.pickBatchMaxOrders`: one cart's slots. */
  maxOrders: number;
  /** `Settings.pickBatchSuggestionCount`: how many cards to show. */
  count: number;
};

const SHARED_SHOWN = 3;

const keysOf = (order: SuggestionOrder) => new Set(order.lines.map((l) => l.key));

/** Suggestions from `orders`, which must already be in queue order (priority desc, oldest, id). */
export function suggestBatches(
  orders: SuggestionOrder[],
  { maxOrders, count }: SuggestionLimits,
): BatchSuggestion[] {
  const position = new Map(orders.map((o, i) => [o.id, i]));
  const keys = new Map(orders.map((o) => [o.id, keysOf(o)]));
  const used = new Set<string>();
  const suggestions: BatchSuggestion[] = [];

  for (const start of orders) {
    if (suggestions.length >= count) break;
    if (used.has(start.id)) continue;
    // Used as a start once, even if it ends up alone and dropped: it isn't tried again.
    used.add(start.id);
    const members = [start];
    const onCart = new Set(keys.get(start.id));

    while (members.length < maxOrders) {
      let best: SuggestionOrder | null = null;
      let bestShared = 0;
      for (const candidate of orders) {
        if (used.has(candidate.id)) continue;
        let shared = 0;
        for (const key of keys.get(candidate.id) ?? []) if (onCart.has(key)) shared += 1;
        // Strictly more: an equal count keeps the earlier order, so ties go by queue order.
        if (shared > bestShared) {
          best = candidate;
          bestShared = shared;
        }
      }
      if (!best) break;
      members.push(best);
      used.add(best.id);
      for (const key of keys.get(best.id) ?? []) onCart.add(key);
    }

    // A lone order is only worth a card when it's the top one: it keeps the oldest order in view.
    if (members.length === 1 && suggestions.length > 0) continue;
    members.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    suggestions.push(toSuggestion(members));
  }
  return suggestions;
}

function toSuggestion(members: SuggestionOrder[]): BatchSuggestion {
  const products = new Map<string, BatchSuggestionShared>();
  let units = 0;
  for (const order of members) {
    for (const line of order.lines) {
      units += line.quantity;
      const product = products.get(line.key) ?? {
        key: line.key,
        name: line.name,
        units: 0,
        orders: 0,
      };
      product.units += line.quantity;
      products.set(line.key, product);
    }
    for (const key of keysOf(order)) {
      const product = products.get(key);
      if (product) product.orders += 1;
    }
  }

  const oldest = members.reduce((a, b) => (b.orderedAt < a.orderedAt ? b : a));
  // Stable sort: equal products keep the order they first appeared in.
  const shared = [...products.values()]
    .filter((p) => p.orders >= 2)
    .sort((a, b) => b.orders - a.orders || b.units - a.units)
    .slice(0, SHARED_SHOWN);

  return {
    orders: members.map(({ id, number, version }) => ({ id, number, version })),
    units,
    stops: products.size,
    oldest: { number: oldest.number, orderedAt: oldest.orderedAt },
    shared,
  };
}
