// Pick order (SPEC-picking "Pick order", FR-PICK-05): the walk through the shelves. The store keeps
// no bins today, so in practice lines sort by name; bins win as soon as sync fills them.

export type Sortable = { id: string; binLocation: string | null; name: string; sku: string | null };

// Numeric so "A2" comes before "A10"; base sensitivity so case doesn't matter.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compare(a: Sortable, b: Sortable): number {
  if (a.binLocation !== b.binLocation) {
    if (a.binLocation === null) return 1;
    if (b.binLocation === null) return -1;
    const byBin = collator.compare(a.binLocation, b.binLocation);
    if (byBin !== 0) return byBin;
  }
  return (
    collator.compare(a.name, b.name) ||
    collator.compare(a.sku ?? "", b.sku ?? "") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Lines in pick order: bin (naturally, missing last), then name, SKU and id. Returns a new array. */
export function pickOrder<T extends Sortable>(lines: readonly T[]): T[] {
  return [...lines].sort(compare);
}
