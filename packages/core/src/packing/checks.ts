import type { PackCheckMode, Trip } from "@woolrus/contracts";
import {
  estimateWeightOz,
  fitsIn,
  type InnerDims,
  isMeasured,
  type SuggestUnit,
  unitFits,
} from "./suggest";

// Packing checks (SPEC-packing A1 "Packing checks"). Pure: the caller loads the package, its units
// and the settings. The pack view, and later the packed gate and the trips saved when an order
// leaves Packing, all call this one function so they can't disagree.

export type { Trip };

/** The settings columns the checks read; a Prisma `Settings` row fits as it is. */
export type CheckSettings = {
  packCheckOverMax: PackCheckMode;
  packCheckUnderMin: PackCheckMode;
  packCheckWeightOff: PackCheckMode;
  packCheckWeightStale: PackCheckMode;
  packCheckNoFit: PackCheckMode;
  packCheckCustomDimensions: PackCheckMode;
  /** Whole percent, 5–100. */
  packCheckWeightOffPercent: number;
};

/** A package as the checks see it: its box (or custom dimensions) and weight. */
export type CheckPackage = {
  box:
    | (InnerDims & {
        name: string;
        minWeightOz: number | null;
        maxWeightOz: number | null;
        tareWeightOz: number | null;
      })
    | null;
  /** Custom dimensions; null when the package has a box. */
  dimensions: InnerDims | null;
  weightOz: number | null;
  overrideReason: string | null;
  weightStale: boolean;
  discarded: boolean;
};

/** Whole percent of `weightOz` off `estimateOz`, signed. Rounded first so 125 vs 100 is exactly 25. */
const percentOff = (weightOz: number, estimateOz: number) =>
  Math.round(((weightOz - estimateOz) / estimateOz) * 1e6) / 1e4;

/**
 * The trips of one package, in the spec table's order. Checks set to off aren't evaluated, a
 * discarded package isn't checked, and an unweighed one trips nothing that needs a weight (the
 * gate's `packageNoWeight` already stops it).
 */
export function evaluateChecks(
  pkg: CheckPackage,
  units: SuggestUnit[],
  settings: CheckSettings,
): Trip[] {
  if (pkg.discarded) return [];
  const trips: Trip[] = [];
  const on = (mode: PackCheckMode): mode is "WARN" | "BLOCK" => mode !== "OFF";
  const { box, weightOz } = pkg;

  // Custom sizes have no box to read a min or max from (assumption 2).
  const max = box?.maxWeightOz ?? null;
  if (on(settings.packCheckOverMax) && weightOz !== null && max !== null && weightOz > max) {
    trips.push({
      check: "OVER_MAX",
      mode: settings.packCheckOverMax,
      details: {
        weightOz,
        maxOz: max,
        ...(pkg.overrideReason ? { reason: pkg.overrideReason } : {}),
      },
    });
  }

  const min = box?.minWeightOz ?? null;
  if (on(settings.packCheckUnderMin) && weightOz !== null && min !== null && weightOz < min) {
    trips.push({
      check: "UNDER_MIN",
      mode: settings.packCheckUnderMin,
      details: { weightOz, minOz: min },
    });
  }

  if (on(settings.packCheckWeightOff) && weightOz !== null) {
    const estimateOz = estimateWeightOz(units, box);
    if (estimateOz !== null && estimateOz > 0) {
      const off = percentOff(weightOz, estimateOz);
      if (Math.abs(off) > settings.packCheckWeightOffPercent) {
        trips.push({
          check: "WEIGHT_OFF",
          mode: settings.packCheckWeightOff,
          details: { weightOz, estimateOz, percent: Math.round(off) },
        });
      }
    }
  }

  if (on(settings.packCheckWeightStale) && weightOz !== null && pkg.weightStale) {
    trips.push({
      check: "WEIGHT_STALE",
      mode: settings.packCheckWeightStale,
      details: { weightOz },
    });
  }

  // Units without dimensions take no space, so one measured unit is enough to check (decision 12).
  const space = box ?? pkg.dimensions;
  const measured = units.filter(isMeasured);
  if (on(settings.packCheckNoFit) && space && measured.length > 0 && !fitsIn(measured, space)) {
    const tooBig = measured.filter((u) => !unitFits(u, space));
    // Each fits alone but not all together: they all share the blame.
    const items = (tooBig.length > 0 ? tooBig : measured).map((u) => u.name);
    trips.push({
      check: "NO_FIT",
      mode: settings.packCheckNoFit,
      details: box ? { boxName: box.name, items } : { items },
    });
  }

  if (on(settings.packCheckCustomDimensions) && !box && pkg.dimensions) {
    trips.push({
      check: "CUSTOM_DIMENSIONS",
      mode: settings.packCheckCustomDimensions,
      details: { ...pkg.dimensions },
    });
  }
  return trips;
}
