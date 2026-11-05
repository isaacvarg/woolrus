import type { useFormatter } from "next-intl";

/**
 * Cents in their currency; USD when the data carries none (ship-from and the store are USD, SPEC-qa
 * assumption 4). A code that isn't ISO 4217-shaped (a provider's typo) can't be formatted, and
 * next-intl's fallback would drop the currency, so it shows the number and the code.
 */
export function money(
  format: ReturnType<typeof useFormatter>,
  cents: number,
  currency = "USD",
): string {
  if (/^[A-Z]{3}$/.test(currency)) {
    return format.number(cents / 100, { style: "currency", currency });
  }
  const amount = format.number(cents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount} ${currency}`;
}
