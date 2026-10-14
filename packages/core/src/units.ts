import type { Prisma } from "@woolrus/db";

// Canonical units are ounces and inches (see docs/decisions.md). Conversion to other units
// happens only for display, here.

export const OZ_PER_LB = 16;

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
