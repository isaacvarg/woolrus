import type { RateError } from "@woolrus/contracts";
import type { DbTx, Prisma, RateFetchSource, RateFetchTrigger } from "@woolrus/db";
import type {
  ProviderId,
  ProviderRate,
  RateRequest,
  ShipAddress,
} from "../adapters/shipping/provider";
import { compareRates } from "../carriers/compare";
import { uuidv7 } from "../ids";

// The quote log (SPEC-rate-history "Writing the log"): append-only, beside the working rates that
// carriers replaces on every fetch.

/** A quote as the fetch kept it, with the catalog rows it was matched to. */
export type LoggedRate = ProviderRate & {
  provider: ProviderId;
  carrierId: string;
  serviceId: string;
  carrierCode: string;
  /** The provider couldn't buy at fetch time. */
  quoteOnly: boolean;
};

export type LogRateFetchInput = {
  source: RateFetchSource;
  trigger: RateFetchTrigger;
  orderId?: string;
  packageId?: string;
  labRunId?: string;
  labAddressId?: string;
  labParcelId?: string;
  /** Reduced to the lane here, so no caller can store a full address by mistake (decision 3). */
  shipTo: ShipAddress;
  residential: boolean;
  international: boolean;
  boxId?: string | null;
  parcel: RateRequest["package"];
  providerErrors: RateError[];
  rates: LoggedRate[];
  /** The providers of this fetch that are fake adapters (decision 6). */
  fakeProviders: ReadonlySet<ProviderId>;
};

/** The lane: country, state and the postal code's first three characters, never the rest. */
export function lane(shipTo: Pick<ShipAddress, "country" | "state" | "postalCode">) {
  return {
    destCountry: shipTo.country,
    destState: shipTo.state?.trim() || null,
    destZip3: shipTo.postalCode.trim().slice(0, 3) || null,
  };
}

/**
 * Writes one fetch and its quotes on the caller's transaction. No permission check: callers hold
 * theirs. `quoteIds[i]` is the logged quote of `rates[i]`.
 */
export async function logRateFetch(
  tx: DbTx,
  input: LogRateFetchInput,
): Promise<{ fetchId: string; quoteIds: string[] }> {
  const purchasable = input.rates.filter((rate) => !rate.quoteOnly);
  const cheapest = purchasable.length > 0 ? [...purchasable].sort(compareRates)[0] : undefined;
  const fetch = await tx.rateFetch.create({
    data: {
      source: input.source,
      trigger: input.trigger,
      orderId: input.orderId ?? null,
      packageId: input.packageId ?? null,
      labRunId: input.labRunId ?? null,
      labAddressId: input.labAddressId ?? null,
      labParcelId: input.labParcelId ?? null,
      ...lane(input.shipTo),
      residential: input.residential,
      international: input.international,
      boxId: input.boxId ?? null,
      ...input.parcel,
      providerErrors: input.providerErrors as Prisma.InputJsonArray,
      fake: input.fakeProviders.size > 0,
    },
    select: { id: true },
  });
  // Ids made here so each rate can point at its quote without a read-back.
  const quoteIds = input.rates.map(() => uuidv7());
  await tx.rateQuote.createMany({
    data: input.rates.map((rate, i) => ({
      id: quoteIds[i],
      fetchId: fetch.id,
      provider: rate.provider,
      carrierId: rate.carrierId,
      serviceId: rate.serviceId,
      carrierCode: rate.carrierCode,
      serviceCode: rate.serviceCode,
      serviceName: rate.serviceName,
      amountCents: rate.amountCents,
      currency: rate.currency,
      deliveryDays: rate.deliveryDays ?? null,
      estimatedDeliveryAt: rate.estimatedDeliveryAt ?? null,
      guaranteed: rate.guaranteed,
      quoteOnly: rate.quoteOnly,
      cheapest: rate === cheapest,
      fake: input.fakeProviders.has(rate.provider),
    })),
  });
  return { fetchId: fetch.id, quoteIds };
}
