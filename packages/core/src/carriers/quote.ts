import type { Db, ShipToStatus } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { z } from "zod";
import { ShippingError, shippingErrorFromCause } from "../adapters/shipping/errors";
import {
  type AddressCheck,
  PROVIDER_TIMEOUT_MS,
  type ProviderId,
  type ProviderRate,
  type RateRequest,
  type ShipAddress,
  type ShippingProvider,
  withTimeout,
} from "../adapters/shipping/provider";
import { listUsableServices } from "./carriers";

// Quoting one parcel and checking one address across the enabled providers, shared by the order
// rate fetch (`rates.fetch`) and Rate Lab, so both ask the same services the same way (decision 3).

export type UsableService = Awaited<ReturnType<typeof listUsableServices>>[number];

/** A provider and the services it may be asked to rate on one lane. */
export type LaneProvider = { provider: ShippingProvider; services: UsableService[] };

/** A provider's quote matched to the catalog service it's for. */
export type MatchedRate = ProviderRate & {
  provider: ProviderId;
  service: UsableService;
  carrierId: string;
};

/**
 * One provider's answer for a parcel. `provider` is null only for failures the caller makes before
 * asking anyone (an incomplete parcel or customs).
 */
export type ProviderOutcome =
  | { provider: ProviderId; ok: true; rates: MatchedRate[] }
  | {
      provider: ProviderId | null;
      ok: false;
      messageKey: ErrorCode;
      permanent: boolean;
      params?: Record<string, string | number>;
    };

/**
 * Each provider with its enabled carriers and services for the lane: domestic when ship-to and
 * ship-from share a country, otherwise international (FR-SHIP-02).
 */
export function laneProviders(
  db: Db,
  providers: ShippingProvider[],
  { domestic }: { domestic: boolean },
): Promise<LaneProvider[]> {
  return Promise.all(
    providers.map(async (provider) => ({
      provider,
      services: (await listUsableServices(db, provider.id)).filter((s) =>
        domestic ? s.domestic : s.international,
      ),
    })),
  );
}

const serviceKey = (carrierExternalId: string, code: string) => `${carrierExternalId}\n${code}`;

const providerData = z.record(z.string(), z.unknown()).catch({});

async function askProvider(
  { provider, services }: LaneProvider,
  parcel: Omit<RateRequest, "services">,
  timeoutMs: number,
): Promise<ProviderOutcome> {
  if (services.length === 0) {
    return {
      provider: provider.id,
      ok: false,
      messageKey: "errors.carriers.noCarriers",
      permanent: true,
    };
  }
  let rates: ProviderRate[];
  try {
    const request: RateRequest = {
      ...parcel,
      services: services.map((s) => ({
        carrierExternalId: s.carrier.externalId,
        code: s.code,
        providerData: providerData.parse(s.providerData),
      })),
    };
    rates = await withTimeout(provider.getRates(request), timeoutMs);
  } catch (cause) {
    const error =
      cause instanceof ShippingError ? cause : shippingErrorFromCause("getRates", cause);
    return {
      provider: provider.id,
      ok: false,
      messageKey: error.messageKey,
      permanent: error.permanent,
    };
  }
  // Extras the provider returned for services that aren't on are dropped, and so is a negative
  // price: a malformed quote that would sort first and be selected.
  const byKey = new Map(services.map((s) => [serviceKey(s.carrier.externalId, s.code), s]));
  return {
    provider: provider.id,
    ok: true,
    rates: rates.flatMap((rate) => {
      const service = byKey.get(serviceKey(rate.carrierExternalId, rate.serviceCode));
      return service && rate.amountCents >= 0
        ? [{ ...rate, provider: provider.id, service, carrierId: service.carrierId }]
        : [];
    }),
  };
}

/**
 * Quotes one parcel: every provider of the lane is asked in parallel within the provider timeout,
 * and answers with its matched quotes or the rate error it failed with. Never throws for a
 * provider failure.
 */
export function quoteParcel(
  lane: LaneProvider[],
  parcel: Omit<RateRequest, "services">,
  { timeoutMs = PROVIDER_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ProviderOutcome[]> {
  return Promise.all(lane.map((entry) => askProvider(entry, parcel, timeoutMs)));
}

/** What the address check decided: the address rates use, and what's stored about it. */
export type CheckedAddress = {
  shipTo: ShipAddress;
  status: ShipToStatus;
  messages: string[];
  checkedAt: Date | null;
  residential?: boolean;
};

/**
 * What's stored when rates use the original address: every answer but a correction with an
 * address, which a correction without one falls back to as a warning.
 */
const fallbackStatus: Record<AddressCheck["status"], ShipToStatus> = {
  verified: "VERIFIED",
  corrected: "WARNING",
  warning: "WARNING",
  error: "ERROR",
};

/**
 * FR-SHIP-12: the first provider that can validate checks the address. No such provider, or a
 * check that fails, leaves it `UNCHECKED`; it never throws, so it never stops a fetch or a save.
 */
export async function checkAddress(
  providers: ShippingProvider[],
  original: ShipAddress,
  { now = new Date(), timeoutMs = PROVIDER_TIMEOUT_MS }: { now?: Date; timeoutMs?: number } = {},
): Promise<CheckedAddress> {
  const unchecked: CheckedAddress = {
    shipTo: original,
    status: "UNCHECKED",
    messages: [],
    checkedAt: null,
  };
  const validator = providers.find((p) => p.capabilities.addressValidation && p.validateAddress);
  if (!validator?.validateAddress) return unchecked;
  let check: AddressCheck;
  try {
    check = await withTimeout(validator.validateAddress(original), timeoutMs);
  } catch {
    return unchecked;
  }
  const checked = { messages: check.messages, checkedAt: now, residential: check.residential };
  // A correction without an address to use is only a warning.
  if (check.status === "corrected" && check.address) {
    return { ...checked, shipTo: check.address, status: "CORRECTED" };
  }
  return { ...checked, shipTo: original, status: fallbackStatus[check.status] };
}
