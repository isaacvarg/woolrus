import { type ProviderId, providerIds } from "../adapters/shipping/provider";

type Comparable = {
  amountCents: number;
  deliveryDays?: number | null;
  provider: ProviderId;
  serviceName: string;
  carrierId: string;
  serviceCode: string;
};

/**
 * Cheapest first; ties: fewer delivery days, then provider order, then service name, then the
 * carrier account and service code, which together are unique, so two accounts of one carrier at
 * the same price still order the same way everywhere. The one rule for "cheapest": carriers'
 * pre-selection, the quote log's `cheapest` and QA's reason check all use it.
 */
export function compareRates(a: Comparable, b: Comparable): number {
  return (
    a.amountCents - b.amountCents ||
    (a.deliveryDays ?? Number.POSITIVE_INFINITY) - (b.deliveryDays ?? Number.POSITIVE_INFINITY) ||
    providerIds.indexOf(a.provider) - providerIds.indexOf(b.provider) ||
    a.serviceName.localeCompare(b.serviceName) ||
    a.carrierId.localeCompare(b.carrierId) ||
    a.serviceCode.localeCompare(b.serviceCode)
  );
}

/**
 * The rate carriers would pre-select: the cheapest whose provider can buy it. QA's reason for a
 * pricier pick is only asked for, and only accepted, when the selected rate isn't this one.
 */
export function cheapestPurchasable<T extends Comparable>(
  rates: readonly T[],
  quoteOnly: ReadonlySet<ProviderId>,
): T | undefined {
  return [...rates].filter((rate) => !quoteOnly.has(rate.provider)).sort(compareRates)[0];
}
