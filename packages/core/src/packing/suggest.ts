// Box suggestion (SPEC-packing "Box suggestion"). Pure: the caller loads units and boxes. A
// suggestion is only ever shown; nothing here applies it.

/** Share of a box's inner volume the units may fill; the rest is padding. */
export const FILL_FACTOR = 0.8;

/** A line's units for suggesting: dimensions and weight from the variation, else the product. */
export type SuggestUnit = {
  name: string;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  weightOz: number | null;
  /** How many units of this kind; defaults to 1. */
  quantity?: number;
};

export type SuggestBox = {
  id: string;
  name: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  maxWeightOz: number | null;
  tareWeightOz: number | null;
  archived: boolean;
};

export type Suggestion<B extends SuggestBox = SuggestBox> =
  | { kind: "box"; box: B; estimatedWeightOz: number }
  | { kind: "split" }
  | { kind: "unknown"; missing: string[] }
  | { kind: "none" };

const round2 = (n: number) => Math.round(n * 100) / 100;
const volume = (l: number, w: number, h: number) => l * w * h;
const sorted = (l: number, w: number, h: number) =>
  [l, w, h].sort((a, b) => a - b) as [number, number, number];
const count = (u: SuggestUnit) => u.quantity ?? 1;

/** Σ unit weight + the box's tare (none for a custom size), or null when any weight is missing. */
export function estimateWeightOz(
  units: SuggestUnit[],
  box: { tareWeightOz: number | null } | null,
): number | null {
  if (units.length === 0) return null;
  let total = box?.tareWeightOz ?? 0;
  for (const u of units) {
    if (u.weightOz === null) return null;
    total += u.weightOz * count(u);
  }
  return round2(total);
}

/** A unit with all three dimensions: the only kind that takes space in a fit test. */
export type MeasuredUnit = SuggestUnit & { lengthIn: number; widthIn: number; heightIn: number };

export const isMeasured = (u: SuggestUnit): u is MeasuredUnit =>
  u.lengthIn !== null && u.widthIn !== null && u.heightIn !== null;

export type InnerDims = { lengthIn: number; widthIn: number; heightIn: number };

/** Whether one unit fits the space on its own: each sorted dimension ≤ the sorted inner one. */
export function unitFits(unit: MeasuredUnit, inner: InnerDims): boolean {
  const space = sorted(inner.lengthIn, inner.widthIn, inner.heightIn);
  return sorted(unit.lengthIn, unit.widthIn, unit.heightIn).every(
    (d, i) => d <= (space[i] as number),
  );
}

/**
 * The fit rule the suggestion and the `NO_FIT` check share (SPEC-packing A1), so they can't
 * disagree: every unit fits on its own, and their total volume is at most the inner volume ×
 * `FILL_FACTOR`. Weight isn't part of it.
 */
export function fitsIn(units: MeasuredUnit[], inner: InnerDims): boolean {
  if (!units.every((u) => unitFits(u, inner))) return false;
  const unitVolume = units.reduce(
    (sum, u) => sum + volume(u.lengthIn, u.widthIn, u.heightIn) * count(u),
    0,
  );
  return unitVolume <= volume(inner.lengthIn, inner.widthIn, inner.heightIn) * FILL_FACTOR;
}

export function suggestBox<B extends SuggestBox>(units: SuggestUnit[], boxes: B[]): Suggestion<B> {
  if (units.length === 0) return { kind: "none" };
  const missing = units.filter((u) => !isMeasured(u) || u.weightOz === null).map((u) => u.name);
  if (missing.length > 0) return { kind: "unknown", missing };
  const measured = units as MeasuredUnit[];

  const fits = boxes
    .filter((box) => !box.archived)
    .filter((box) => {
      if (!fitsIn(measured, box)) return false;
      const gross = estimateWeightOz(units, box);
      return box.maxWeightOz === null || (gross as number) <= box.maxWeightOz;
    })
    .sort(
      (a, b) =>
        volume(a.lengthIn, a.widthIn, a.heightIn) - volume(b.lengthIn, b.widthIn, b.heightIn) ||
        (a.maxWeightOz ?? Number.POSITIVE_INFINITY) - (b.maxWeightOz ?? Number.POSITIVE_INFINITY) ||
        a.name.localeCompare(b.name),
    );
  const best = fits[0];
  if (!best) return { kind: "split" };
  return { kind: "box", box: best, estimatedWeightOz: estimateWeightOz(units, best) as number };
}
