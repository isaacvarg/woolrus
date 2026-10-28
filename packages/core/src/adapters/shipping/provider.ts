// The one way core talks to a shipping provider (SPEC-carriers "The seam"). Units at this boundary
// are ours: money in integer cents, weights in ounces, dimensions in inches, times as Dates.
// Adapters convert to and from the provider's units, and throw only `ShippingError`.

export const providerIds = ["SHIPSTATION", "BRIDGE_SOURCE"] as const; // Prisma enum ShippingProviderId
export type ProviderId = (typeof providerIds)[number];

/** A provider's whole `getRates` for one package, however many calls it makes inside. */
export const PROVIDER_TIMEOUT_MS = 20_000;

/**
 * `work`, or a `TimeoutError` after `ms` (which `shippingErrorFromCause` reads as `timeout`). The
 * call itself isn't cancelled: its late answer is dropped.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DOMException("provider call timed out", "TimeoutError")),
      ms,
    );
  });
  work.catch(() => {}); // a late failure after the timeout isn't anyone's to handle
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a provider can do. Missing capabilities are skipped for that provider, never an error. */
export type ProviderCapabilities = {
  addressValidation: boolean;
  /** Look a label up by our idempotency key, so `qa` can reconcile a purchase whose response was lost. */
  labelLookup: boolean;
  void: boolean;
  manifests: boolean;
};

/** Adapter-only data stored with a service (`CarrierService.providerData`). */
export type ProviderData = Record<string, unknown>;

export type ProviderService = {
  code: string;
  name: string;
  domestic: boolean;
  international: boolean;
  providerData: ProviderData;
};

export type ProviderCarrier = {
  externalId: string;
  /** The carrier's own code (`ups`, `usps`): what tracking shows and the Woo push sends. */
  code: string;
  name: string;
  /** What the provider says to tell several accounts of one carrier apart. */
  nickname?: string;
  /** The account number's last 4 characters; the whole number is never kept. */
  accountSuffix?: string;
  /** Labels are paid from the provider's balance, not billed to the carrier account. */
  billedByProvider?: boolean;
  services: ProviderService[];
};

/** A complete postal address (ship-from, or a ship-to that passed resolution). */
export type ShipAddress = {
  name: string;
  company?: string;
  phone?: string;
  email?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
};

export type AddressCheck = {
  status: "verified" | "corrected" | "warning" | "error";
  /** The provider's normalised address, when it has one. */
  address?: ShipAddress;
  residential?: boolean;
  messages: string[];
};

export type RateRequest = {
  orderNumber: string;
  shipFrom: ShipAddress;
  shipTo: ShipAddress;
  residential: boolean;
  package: { lengthIn: number; widthIn: number; heightIn: number; weightOz: number };
  items: { sku: string | null; name: string; quantity: number }[];
  /** Only enabled carriers and services (FR-SHIP-02). */
  services: { carrierExternalId: string; code: string; providerData: ProviderData }[];
};

export type ProviderRate = {
  /** ShipStation buys from a rate id; Bridge Source has none. */
  providerRateId?: string;
  providerShipmentId?: string;
  carrierExternalId: string;
  serviceCode: string;
  serviceName: string;
  amountCents: number;
  currency: string;
  deliveryDays?: number;
  estimatedDeliveryAt?: Date;
  guaranteed: boolean;
  trackable: boolean;
  /** The provider's own expiry; the rate fetch applies `RATE_TTL_HOURS` when it has none. */
  expiresAt?: Date;
};

export type PurchaseInput = {
  rate: {
    providerRateId?: string;
    providerShipmentId?: string;
    carrierExternalId: string;
    serviceCode: string;
    providerData: ProviderData;
  };
  /** Rebuilt by `qa` from the package and ship-to; a provider without rate ids books from it. */
  shipment: RateRequest;
  idempotencyKey: string;
  reference: string;
  format: "pdf";
  size: "4x6";
};

export type PurchasedLabel = {
  providerLabelId: string;
  providerShipmentId?: string;
  trackingNumber: string;
  carrierCode: string;
  serviceCode: string;
  costCents?: number;
  currency: string;
  document: { url: string } | { pdf: Uint8Array };
  shipDate: Date;
};

export interface ShippingProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Succeeds when the credentials are accepted. */
  ping(): Promise<void>;
  listCarriers(): Promise<ProviderCarrier[]>;
  validateAddress?(address: ShipAddress): Promise<AddressCheck>;
  getRates(request: RateRequest): Promise<ProviderRate[]>;
  purchaseLabel(input: PurchaseInput): Promise<PurchasedLabel>;
  findLabel?(idempotencyKey: string): Promise<PurchasedLabel | null>;
  /** `approved: false` is the provider declining, returned rather than thrown. */
  voidLabel?(providerLabelId: string): Promise<{ approved: boolean; message?: string }>;
}
