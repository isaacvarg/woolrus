import type { DbTx, Prisma } from "@woolrus/db";
import type { LineRow } from "../picking/lines";
import { toNumber } from "../units";
import type { CheckPackage, CheckSettings } from "./checks";
import type { SuggestUnit } from "./suggest";

// What `evaluateChecks` reads, loaded from the database. Kept apart from queries.ts so the packed
// gate and completePacking can use it too without importing the pack view (or settings/service,
// which imports workflow back).

/** The columns' defaults, for a database whose settings row isn't created yet. */
const defaultCheckSettings: CheckSettings = {
  packCheckOverMax: "WARN",
  packCheckUnderMin: "WARN",
  packCheckWeightOff: "WARN",
  packCheckWeightStale: "WARN",
  packCheckNoFit: "WARN",
  packCheckBoxNotScanned: "OFF",
  packCheckCustomDimensions: "WARN",
  packCheckWeightOffPercent: 25,
};

/** The packing check settings, read live: a mode change applies to orders in Packing at once. */
export async function loadCheckSettings(tx: DbTx): Promise<CheckSettings> {
  const row = await tx.settings.findFirst({
    select: {
      packCheckOverMax: true,
      packCheckUnderMin: true,
      packCheckWeightOff: true,
      packCheckWeightStale: true,
      packCheckNoFit: true,
      packCheckBoxNotScanned: true,
      packCheckCustomDimensions: true,
      packCheckWeightOffPercent: true,
    },
  });
  return row ?? defaultCheckSettings;
}

/** A line's size and weight: the variation's, else the product's. */
export function unitOf(row: LineRow, quantity: number): SuggestUnit {
  const pick = (key: "weightOz" | "lengthIn" | "widthIn" | "heightIn") =>
    toNumber(row.variation?.[key] ?? row.product?.[key] ?? null);
  return {
    name: row.name,
    lengthIn: pick("lengthIn"),
    widthIn: pick("widthIn"),
    heightIn: pick("heightIn"),
    weightOz: pick("weightOz"),
    quantity,
  };
}

/** A package row with its box, as every package read already loads it. */
export type PackageWithBox = Prisma.PackageGetPayload<{ include: { box: true } }>;

/** A package row as the checks see it. */
export function toCheckPackage(pkg: PackageWithBox): CheckPackage {
  const { box, lengthIn, widthIn, heightIn } = pkg;
  return {
    box: box
      ? {
          name: box.name,
          lengthIn: box.lengthIn.toNumber(),
          widthIn: box.widthIn.toNumber(),
          heightIn: box.heightIn.toNumber(),
          minWeightOz: toNumber(box.minWeightOz),
          maxWeightOz: toNumber(box.maxWeightOz),
          tareWeightOz: toNumber(box.tareWeightOz),
        }
      : null,
    dimensions:
      lengthIn && widthIn && heightIn
        ? {
            lengthIn: lengthIn.toNumber(),
            widthIn: widthIn.toNumber(),
            heightIn: heightIn.toNumber(),
          }
        : null,
    weightOz: toNumber(pkg.weightOz),
    overrideReason: pkg.weightOverrideReason,
    weightStale: pkg.weightStale,
    boxScanned: pkg.boxScanned,
    discarded: pkg.discardedAt !== null,
  };
}
