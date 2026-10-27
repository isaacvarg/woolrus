import { z } from "zod";
import { base, Id } from "./base";
import { OrderAddress } from "./orders";
import { IntegrationUrl, SecretStatus } from "./settings";

// Shipping provider accounts (SPEC-carriers "Provider accounts and settings", "API"). Credentials are
// write-only: no output schema here can carry a value, only `{ configured }` per field (NFR-SEC-03).

/** Mirrors the database enum `ShippingProviderId`, in the fixed order providers are shown and asked. */
export const ShippingProviderId = z.enum(["SHIPSTATION", "BRIDGE_SOURCE"]);
export type ShippingProviderId = z.infer<typeof ShippingProviderId>;

const credential = z.string().trim().min(1).max(500);

/** Each provider's credential fields, stored encrypted together as one JSON blob. */
export const providerCredentialSchemas = {
  SHIPSTATION: z.object({ apiKey: credential }),
  BRIDGE_SOURCE: z.object({ apiKey: credential, customerId: credential }),
} satisfies Record<ShippingProviderId, z.ZodObject>;

/** The credential field names of a provider, in the order the settings card shows them. */
export function providerCredentialFields(provider: ShippingProviderId): string[] {
  return Object.keys(providerCredentialSchemas[provider].shape);
}

/** Non-secret config a provider takes. Bridge Source's host isn't in its docs, so it's set here. */
export const providerConfigFields: Record<ShippingProviderId, readonly "baseUrl"[]> = {
  SHIPSTATION: [],
  BRIDGE_SOURCE: ["baseUrl"],
};

export const ProviderAccount = z.object({
  provider: ShippingProviderId,
  enabled: z.boolean(),
  /** Whether this build has an adapter for it (or its fake, in dev). Without one it can't be enabled. */
  adapterAvailable: z.boolean(),
  /** Every credential field of the provider, set or not. Never a value. */
  credentials: z.record(z.string(), SecretStatus),
  config: z.object({ baseUrl: z.string().nullable() }),
  /** The last Test connection (or health check): when, and the error key if it failed. */
  lastCheckedAt: z.date().nullable(),
  lastErrorKey: z.string().nullable(),
  carrierCount: z.number(),
});
export type ProviderAccount = z.infer<typeof ProviderAccount>;

const ProviderInput = z.object({ provider: ShippingProviderId });

export const SetProviderCredentialsInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("SHIPSTATION"),
    credentials: providerCredentialSchemas.SHIPSTATION,
  }),
  z.object({
    provider: z.literal("BRIDGE_SOURCE"),
    credentials: providerCredentialSchemas.BRIDGE_SOURCE,
  }),
]);
export type SetProviderCredentialsInput = z.infer<typeof SetProviderCredentialsInput>;

export const ClearProviderCredentialsInput = ProviderInput;
export type ClearProviderCredentialsInput = z.infer<typeof ClearProviderCredentialsInput>;

/** Only Bridge Source has config so far. */
export const UpdateProviderConfigInput = z.object({
  provider: z.literal("BRIDGE_SOURCE"),
  baseUrl: IntegrationUrl.nullable(),
});
export type UpdateProviderConfigInput = z.infer<typeof UpdateProviderConfigInput>;

/** `credentialsCleared`: the base URL moved to another origin, so the saved credentials were removed. */
export const UpdateProviderConfigResult = ProviderAccount.extend({
  credentialsCleared: z.boolean(),
});
export type UpdateProviderConfigResult = z.infer<typeof UpdateProviderConfigResult>;

export const TestProviderInput = ProviderInput;
export type TestProviderInput = z.infer<typeof TestProviderInput>;

/** Like the store's Test connection: a refused ping is a result the card shows, not an error. */
export const TestProviderResult = z.object({
  ok: z.boolean(),
  /** `errors.shipping.<kind>` when the ping failed. */
  messageKey: z.string().nullable(),
  account: ProviderAccount,
});
export type TestProviderResult = z.infer<typeof TestProviderResult>;

export const SetProviderEnabledInput = ProviderInput.extend({ enabled: z.boolean() });
export type SetProviderEnabledInput = z.infer<typeof SetProviderEnabledInput>;

export const SyncCarriersInput = ProviderInput;
export type SyncCarriersInput = z.infer<typeof SyncCarriersInput>;

/** What a sync changed. Missing ones were listed before and aren't now; they're kept, not deleted. */
export const SyncCarriersResult = z.object({
  carriersAdded: z.number(),
  servicesAdded: z.number(),
  carriersMissing: z.number(),
  servicesMissing: z.number(),
});
export type SyncCarriersResult = z.infer<typeof SyncCarriersResult>;

export const SetShippingEnabledInput = z.object({ id: Id, enabled: z.boolean() });
export type SetShippingEnabledInput = z.infer<typeof SetShippingEnabledInput>;

/** `missing`: the provider stopped listing it at the last sync, so it's never sent. */
export const ShippingServiceConfig = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  domestic: z.boolean(),
  international: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
});
export type ShippingServiceConfig = z.infer<typeof ShippingServiceConfig>;

export const ShippingCarrierConfig = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  missing: z.boolean(),
  services: z.array(ShippingServiceConfig),
});
export type ShippingCarrierConfig = z.infer<typeof ShippingCarrierConfig>;

/** A provider's synced carriers and services, for Settings → Shipping. */
export const ProviderShippingConfig = z.object({
  provider: ShippingProviderId,
  lastSyncedAt: z.date().nullable(),
  carriers: z.array(ShippingCarrierConfig),
});
export type ProviderShippingConfig = z.infer<typeof ProviderShippingConfig>;

/** Mirrors the database enum `ShipToStatus` (SPEC-carriers "Ship-to and address validation"). */
export const ShipToStatus = z.enum([
  "UNCHECKED",
  "VERIFIED",
  "CORRECTED",
  "WARNING",
  "ERROR",
  "INCOMPLETE",
]);
export type ShipToStatus = z.infer<typeof ShipToStatus>;

/** Mirrors the database enum `RatesStatus`. `STALE`: the package changed after its rates were fetched. */
export const RatesStatus = z.enum(["NONE", "FETCHING", "READY", "FAILED", "STALE"]);
export type RatesStatus = z.infer<typeof RatesStatus>;

/** Why a package has no rates from a provider; `provider` is null when no provider was asked. */
export const RateError = z.object({
  provider: ShippingProviderId.nullable(),
  messageKey: z.string(),
});
export type RateError = z.infer<typeof RateError>;

export const ShippingRateView = z.object({
  id: z.string(),
  provider: ShippingProviderId,
  carrierName: z.string(),
  serviceName: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  deliveryDays: z.number().int().nullable(),
  estimatedDeliveryAt: z.date().nullable(),
  guaranteed: z.boolean(),
  expiresAt: z.date().nullable(),
  expired: z.boolean(),
  selected: z.boolean(),
});
export type ShippingRateView = z.infer<typeof ShippingRateView>;

/** A package's rates, cheapest first, and the providers that returned none. */
export const PackageShipping = z.object({
  id: z.string(),
  number: z.number().int(),
  ratesStatus: RatesStatus,
  ratesFetchedAt: z.date().nullable(),
  rateErrors: z.array(RateError),
  rates: z.array(ShippingRateView),
});
export type PackageShipping = z.infer<typeof PackageShipping>;

/**
 * The address rates use (`address`), the one resolved from the order before any check
 * (`original`), and the check's result. `INCOMPLETE`: `messages` are the missing field names.
 */
export const ShipToView = z.object({
  status: ShipToStatus,
  address: OrderAddress.nullable(),
  original: OrderAddress.nullable(),
  messages: z.array(z.string()),
  checkedAt: z.date().nullable(),
});
export type ShipToView = z.infer<typeof ShipToView>;

/** `refreshable`: in QA with no live label, so `refreshRates` would be accepted (for an `order.qa` user). */
export const OrderShipping = z.object({
  orderId: z.string(),
  refreshable: z.boolean(),
  shipTo: ShipToView,
  packages: z.array(PackageShipping),
});
export type OrderShipping = z.infer<typeof OrderShipping>;

export const OrderShippingInput = z.object({ orderId: Id });
export type OrderShippingInput = z.infer<typeof OrderShippingInput>;

export const RefreshRatesInput = OrderShippingInput;
export type RefreshRatesInput = z.infer<typeof RefreshRatesInput>;

export const carriers = {
  providers: base
    .route({
      method: "GET",
      path: "/shipping/providers",
      tags: ["Shipping"],
      summary: "Shipping provider accounts (admin)",
    })
    .output(z.array(ProviderAccount)),

  setCredentials: base
    .route({
      method: "PUT",
      path: "/shipping/providers/{provider}/credentials",
      tags: ["Shipping"],
      summary: "Set a provider's credentials (write-only)",
    })
    .input(SetProviderCredentialsInput)
    .output(ProviderAccount),

  clearCredentials: base
    .route({
      method: "DELETE",
      path: "/shipping/providers/{provider}/credentials",
      tags: ["Shipping"],
      summary: "Clear a provider's credentials and disable it",
    })
    .input(ClearProviderCredentialsInput)
    .output(ProviderAccount),

  updateConfig: base
    .route({
      method: "PATCH",
      path: "/shipping/providers/{provider}",
      tags: ["Shipping"],
      summary: "Update a provider's non-secret config",
    })
    .input(UpdateProviderConfigInput)
    .output(UpdateProviderConfigResult),

  test: base
    .route({
      method: "POST",
      path: "/shipping/providers/{provider}/test",
      tags: ["Shipping"],
      summary: "Test a provider's saved credentials",
    })
    .input(TestProviderInput)
    .output(TestProviderResult),

  setProviderEnabled: base
    .route({
      method: "POST",
      path: "/shipping/providers/{provider}/enabled",
      tags: ["Shipping"],
      summary: "Enable or disable a provider",
    })
    .input(SetProviderEnabledInput)
    .output(ProviderAccount),

  config: base
    .route({
      method: "GET",
      path: "/shipping/config",
      tags: ["Shipping"],
      summary: "Each provider's synced carriers and services (admin)",
    })
    .output(z.array(ProviderShippingConfig)),

  sync: base
    .route({
      method: "POST",
      path: "/shipping/providers/{provider}/sync",
      tags: ["Shipping"],
      summary: "Sync a provider's carriers and services",
    })
    .input(SyncCarriersInput)
    .output(SyncCarriersResult),

  setCarrierEnabled: base
    .route({
      method: "POST",
      path: "/shipping/carriers/{id}/enabled",
      tags: ["Shipping"],
      summary: "Turn a carrier on or off",
    })
    .input(SetShippingEnabledInput)
    .output(ShippingCarrierConfig),

  setServiceEnabled: base
    .route({
      method: "POST",
      path: "/shipping/services/{id}/enabled",
      tags: ["Shipping"],
      summary: "Turn a carrier service on or off",
    })
    .input(SetShippingEnabledInput)
    .output(ShippingServiceConfig),

  orderShipping: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/shipping",
      tags: ["Shipping"],
      summary: "An order's ship-to and each package's rates",
    })
    .input(OrderShippingInput)
    .output(OrderShipping),

  refreshRates: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/rates/refresh",
      tags: ["Shipping"],
      summary: "Fetch an order's rates again (QA)",
    })
    .input(RefreshRatesInput)
    .output(OrderShipping),
};
