// Box suggestion (SPEC-packing "Box suggestion"). Pure: the caller loads units and boxes. A
// suggestion is only ever shown; nothing here applies it.

/** Share of a box's inner volume the units may fill; the rest is padding. */
export const FILL_FACTOR = 0.8;
/** A typed weight further than this from the estimate gets a warning (decision 6). */
export const WEIGHT_WARNING_RATIO = 0.25;

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

/** How far `weightOz` is from `estimateOz`, in whole percent (negative = lighter), when more than 25%. */
export function weightOffPercent(
  weightOz: number | null,
  estimateOz: number | null,
): number | null {
  if (weightOz === null || estimateOz === null || estimateOz <= 0) return null;
  const ratio = (weightOz - estimateOz) / estimateOz;
  return Math.abs(ratio) > WEIGHT_WARNING_RATIO ? Math.round(ratio * 100) : null;
}

export function suggestBox<B extends SuggestBox>(units: SuggestUnit[], boxes: B[]): Suggestion<B> {
  if (units.length === 0) return { kind: "none" };
  const missing = units
    .filter(
      (u) =>
        u.lengthIn === null || u.widthIn === null || u.heightIn === null || u.weightOz === null,
    )
    .map((u) => u.name);
  if (missing.length > 0) return { kind: "unknown", missing };

  const shapes = units.map((u) =>
    sorted(u.lengthIn as number, u.widthIn as number, u.heightIn as number),
  );
  const unitVolume = units.reduce((sum, u, i) => {
    const [a, b, c] = shapes[i] as [number, number, number];
    return sum + volume(a, b, c) * count(u);
  }, 0);

  const fits = boxes
    .filter((box) => !box.archived)
    .filter((box) => {
      const inner = sorted(box.lengthIn, box.widthIn, box.heightIn);
      if (!shapes.every((s) => s.every((d, i) => d <= (inner[i] as number)))) return false;
      if (unitVolume > volume(...inner) * FILL_FACTOR) return false;
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
