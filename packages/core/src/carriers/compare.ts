import { type ProviderId, providerIds } from "../adapters/shipping/provider";

type Comparable = {
  amountCents: number;
  deliveryDays?: number | null;
  provider: ProviderId;
  serviceName: string;
};

/**
 * Cheapest first; ties: fewer delivery days, then provider order, then service name. The one rule
 * for "cheapest": carriers' pre-selection and the quote log's `cheapest` both use it.
 */
export function compareRates(a: Comparable, b: Comparable): number {
  return (
    a.amountCents - b.amountCents ||
    (a.deliveryDays ?? Number.POSITIVE_INFINITY) - (b.deliveryDays ?? Number.POSITIVE_INFINITY) ||
    providerIds.indexOf(a.provider) - providerIds.indexOf(b.provider) ||
    a.serviceName.localeCompare(b.serviceName)
  );
}
