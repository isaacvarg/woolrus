import type { WeightDisplay } from "@woolrus/contracts";
import { ouncesToPounds, splitPoundsOunces } from "../units";

// Client-safe: no database or Node imports, so client components can use it via "@woolrus/core/format".

function unit(value: number, unit: "pound" | "ounce", locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 2,
  }).format(value);
}

/** 37 oz -> "2 lb 5 oz" (LB_OZ) or "2.31 lb" (LB_DECIMAL). */
export function formatWeight(oz: number, weightDisplay: WeightDisplay, locale: string): string {
  if (weightDisplay === "LB_DECIMAL") return unit(ouncesToPounds(oz), "pound", locale);
  const split = splitPoundsOunces(oz);
  if (split.lb === 0) return unit(split.oz, "ounce", locale);
  if (split.oz === 0) return unit(split.lb, "pound", locale);
  return `${unit(split.lb, "pound", locale)} ${unit(split.oz, "ounce", locale)}`;
}
