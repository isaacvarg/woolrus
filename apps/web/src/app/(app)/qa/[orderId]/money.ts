import type { useFormatter } from "next-intl";

/** Cents as dollars; ship-from and currency are USD (SPEC-qa assumption 4). */
export const money = (format: ReturnType<typeof useFormatter>, cents: number) =>
  format.number(cents / 100, { style: "currency", currency: "USD" });
