import type { Prisma } from "@woolrus/db";

// Canonical units are ounces and inches (see docs/decisions.md). Conversion to other units
// happens only for display, here.

export const OZ_PER_LB = 16;

/** The units a WooCommerce store can be set to (`woocommerce_weight_unit` / `_dimension_unit`). */
export const weightUnits = ["lbs", "oz", "kg", "g"] as const;
export const dimensionUnits = ["in", "cm", "mm", "m", "yd"] as const;
export type WeightUnit = (typeof weightUnits)[number];
export type DimensionUnit = (typeof dimensionUnits)[number];

const OZ_PER: Record<WeightUnit, number> = {
  lbs: OZ_PER_LB,
  oz: 1,
  kg: 35.27396195,
  g: 0.03527396195,
};
const IN_PER: Record<DimensionUnit, number> = {
  in: 1,
  cm: 1 / 2.54,
  mm: 1 / 25.4,
  m: 100 / 2.54,
  yd: 36,
};

const DECIMAL = /^(-)?(\d*)(?:\.(\d*))?$/;

function parseDecimal(value: string): { negative: boolean; whole: string; fraction: string } {
  const match = DECIMAL.exec(value);
  const [, sign, whole = "", fraction = ""] = match ?? [];
  if (!match || whole + fraction === "") throw new Error(`"${value}" is not a decimal number`);
  return { negative: sign === "-", whole, fraction };
}

/** A weight in the store's unit (decimal string, null when unset) to ounces, to the hundredth. */
export function toOunces(value: string | null, unit: WeightUnit): number | null {
  return value === null ? null : convert(value, OZ_PER[unit]);
}

/** A length in the store's unit (decimal string, null when unset) to inches, to the hundredth. */
export function toInches(value: string | null, unit: DimensionUnit): number | null {
  return value === null ? null : convert(value, IN_PER[unit]);
}

function convert(value: string, factor: number): number {
  parseDecimal(value);
  return Math.round(Number(value) * factor * 100) / 100;
}

/**
 * A decimal amount ("24.00", "8.333333") to integer cents, digit by digit so no float is involved.
 * Sub-cent amounts (Woo's line price is subtotal / quantity) round half away from zero.
 */
export function toCents(value: string): number {
  const { negative, whole, fraction } = parseDecimal(value);
  const digits = fraction.padEnd(3, "0");
  const cents =
    Number(whole || "0") * 100 + Number(digits.slice(0, 2)) + (digits.charAt(2) >= "5" ? 1 : 0);
  return negative && cents !== 0 ? -cents : cents;
}

/** Prisma Decimal (or null) to a plain number for the API. */
export function toNumber(value: Prisma.Decimal): number;
export function toNumber(value: Prisma.Decimal | null): number | null;
export function toNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** 37 oz -> { lb: 2, oz: 5 } */
export function splitPoundsOunces(totalOz: number): { lb: number; oz: number } {
  const lb = Math.floor(totalOz / OZ_PER_LB);
  const oz = Math.round((totalOz - lb * OZ_PER_LB) * 100) / 100;
  return oz === OZ_PER_LB ? { lb: lb + 1, oz: 0 } : { lb, oz };
}

export function ouncesToPounds(oz: number): number {
  return Math.round((oz / OZ_PER_LB) * 1000) / 1000;
}

export function poundsToOunces(lb: number): number {
  return Math.round(lb * OZ_PER_LB * 100) / 100;
}
