import type { SimulatedFailure } from "./contract";
import { shippingErrorFromCause, shippingErrorFromStatus } from "./errors";
import type {
  AddressCheck,
  ProviderCapabilities,
  ProviderCarrier,
  ProviderId,
  ProviderRate,
  PurchasedLabel,
  PurchaseInput,
  RateRequest,
  ShipAddress,
  ShippingProvider,
} from "./provider";

// In-memory providers for dev, unit tests and Playwright, in the two shapes the seam has to carry
// (SPEC-carriers "The seam"): one like ShipStation (every service in one call, rate ids, address
// validation, buys from the rate id) and one like Bridge Source (one quote per service, no rate id,
// books from the shipment, no address validation). Prices are deterministic. Rate ids encode what
// they quote, so a label can be bought in another process than the one that fetched the rate.

export type FakeProviderOptions = {
  /** Any value `"invalid"` makes every call fail as unauthorized. */
  credentials?: Record<string, string>;
  /** Added to every request the provider makes. */
  latencyMs?: number;
  /** Bought labels, by idempotency key. Pass one to share labels between instances. */
  labels?: Map<string, FakeLabel>;
};

export type FakeLabel = PurchasedLabel & { idempotencyKey: string; voided: boolean };

/** One request the fake made, as the real provider would see it. */
export type FakeRequest = { operation: string; carrierExternalId?: string; serviceCode?: string };

type CatalogService = {
  code: string;
  name: string;
  domestic: boolean;
  international: boolean;
  baseCents: number;
  perOzCents: number;
  days: number;
  guaranteed: boolean;
};
type CatalogCarrier = { externalId: string; name: string; services: CatalogService[] };

const UNAUTHORIZED_CREDENTIAL = "invalid";
const BRIDGE_QUOTE_CONCURRENCY = 4;

abstract class FakeProvider implements ShippingProvider {
  abstract readonly id: ProviderId;
  abstract readonly capabilities: ProviderCapabilities;
  readonly requests: FakeRequest[] = [];

  protected readonly labels: Map<string, FakeLabel>;
  readonly #credentials: Record<string, string>;
  readonly #latencyMs: number;
  #failures: SimulatedFailure[] = [];

  constructor(
    protected readonly catalog: CatalogCarrier[],
    options: FakeProviderOptions,
  ) {
    this.#credentials = options.credentials ?? {};
    this.#latencyMs = options.latencyMs ?? 0;
    this.labels = options.labels ?? new Map();
  }

  /** Makes the next `times` requests fail the way the provider's transport would. */
  failNext(failure: SimulatedFailure, times = 1): void {
    for (let i = 0; i < times; i++) this.#failures.push(failure);
  }

  async ping(): Promise<void> {
    await this.request({ operation: "ping" });
  }

  async listCarriers(): Promise<ProviderCarrier[]> {
    await this.request({ operation: "listCarriers" });
    return this.catalog.map((carrier) => ({
      externalId: carrier.externalId,
      name: carrier.name,
      services: carrier.services.map((service) => ({
        code: service.code,
        name: service.name,
        domestic: service.domestic,
        international: service.international,
        providerData: this.providerData(service),
      })),
    }));
  }

  abstract getRates(request: RateRequest): Promise<ProviderRate[]>;
  abstract purchaseLabel(input: PurchaseInput): Promise<PurchasedLabel>;

  protected providerData(_service: CatalogService): Record<string, unknown> {
    return {};
  }

  /** One round trip: latency, then a queued failure or a credentials check. */
  protected async request(request: FakeRequest): Promise<void> {
    this.requests.push(request);
    if (this.#latencyMs > 0) await new Promise((r) => setTimeout(r, this.#latencyMs));
    const failure = this.#failures.shift();
    if (failure === "network") {
      throw shippingErrorFromCause(request.operation, new TypeError("fetch failed"));
    }
    if (failure === "timeout") {
      throw shippingErrorFromCause(
        request.operation,
        new DOMException("The operation timed out", "TimeoutError"),
      );
    }
    if (failure !== undefined) {
      throw shippingErrorFromStatus(request.operation, failure, `fake_${failure}`);
    }
    if (Object.values(this.#credentials).includes(UNAUTHORIZED_CREDENTIAL)) {
      throw shippingErrorFromStatus(request.operation, 401, "invalid_credentials");
    }
  }

  /** The catalog service a request names, if it ships to that country. */
  protected service(
    request: RateRequest,
    carrierExternalId: string,
    code: string,
  ): { carrier: CatalogCarrier; service: CatalogService } | null {
    const carrier = this.catalog.find((c) => c.externalId === carrierExternalId);
    const service = carrier?.services.find((s) => s.code === code);
    if (!carrier || !service) return null;
    const domestic = request.shipTo.country === request.shipFrom.country;
    return (domestic ? service.domestic : service.international) ? { carrier, service } : null;
  }

  protected price(service: CatalogService, request: RateRequest): number {
    return service.baseCents + service.perOzCents * Math.ceil(request.package.weightOz);
  }

  protected newLabel(
    input: PurchaseInput,
    fields: Pick<
      PurchasedLabel,
      "providerLabelId" | "document" | "costCents" | "providerShipmentId"
    >,
  ): FakeLabel {
    const label: FakeLabel = {
      ...fields,
      trackingNumber: `FAKE${digits(18)}`,
      carrierCode: input.rate.carrierExternalId,
      serviceCode: input.rate.serviceCode,
      currency: "USD",
      shipDate: startOfDay(new Date()),
      idempotencyKey: input.idempotencyKey,
      voided: false,
    };
    this.labels.set(input.idempotencyKey, label);
    return label;
  }

  protected label({ idempotencyKey, voided, ...label }: FakeLabel): PurchasedLabel {
    return label;
  }
}

/** Shaped like ShipStation API v2. */
export class FakeShipStationProvider extends FakeProvider {
  readonly id = "SHIPSTATION" as const;
  readonly capabilities = {
    addressValidation: true,
    labelLookup: true,
    void: true,
    manifests: true,
  };

  constructor(options: FakeProviderOptions = {}) {
    super(
      [
        {
          externalId: "se-demo-ground",
          name: "Demo Ground",
          services: [
            service("demo_ground", "Demo Ground", "domestic", 450, 12, 5),
            service("demo_ground_saver", "Demo Ground Saver", "domestic", 395, 14, 7),
          ],
        },
        {
          externalId: "se-demo-express",
          name: "Demo Express",
          services: [
            service("demo_express", "Demo Express", "domestic", 1250, 20, 2, true),
            service(
              "demo_express_intl",
              "Demo Express International",
              "international",
              3200,
              40,
              6,
            ),
          ],
        },
      ],
      options,
    );
  }

  /** Corrects any address line containing "Street"; a postal code of 00000 doesn't exist. */
  async validateAddress(address: ShipAddress): Promise<AddressCheck> {
    await this.request({ operation: "validateAddress" });
    const residential = !address.company;
    if (address.postalCode === "00000") {
      return { status: "error", messages: ["Address not found."] };
    }
    const fix = (line?: string) => line?.replace(/\bStreet\b/g, "St");
    const corrected = {
      ...address,
      address1: fix(address.address1) ?? "",
      address2: fix(address.address2),
    };
    if (address.address2 === undefined) delete corrected.address2;
    if (corrected.address1 !== address.address1 || corrected.address2 !== address.address2) {
      return {
        status: "corrected",
        address: corrected,
        residential,
        messages: ["Street abbreviated."],
      };
    }
    return { status: "verified", address, residential, messages: [] };
  }

  /** Every requested service in one call, each with a rate id. */
  async getRates(request: RateRequest): Promise<ProviderRate[]> {
    await this.request({ operation: "getRates" });
    const shipmentId = `se-shp-${crypto.randomUUID()}`;
    return request.services.flatMap(({ carrierExternalId, code }) => {
      const match = this.service(request, carrierExternalId, code);
      if (!match) return [];
      const amountCents = this.price(match.service, request);
      return [
        {
          providerRateId: `se-rate:${carrierExternalId}:${code}:${amountCents}`,
          providerShipmentId: shipmentId,
          carrierExternalId,
          serviceCode: code,
          serviceName: match.service.name,
          amountCents,
          currency: "USD",
          deliveryDays: match.service.days,
          estimatedDeliveryAt: addDays(startOfDay(new Date()), match.service.days),
          guaranteed: match.service.guaranteed,
          trackable: true,
        },
      ];
    });
  }

  /** Buys from the rate id; the same idempotency key returns the label already bought. */
  async purchaseLabel(input: PurchaseInput): Promise<PurchasedLabel> {
    await this.request({ operation: "purchaseLabel" });
    const existing = this.labels.get(input.idempotencyKey);
    if (existing) return this.label(existing);
    const [prefix, carrierExternalId, code, amount] = (input.rate.providerRateId ?? "").split(":");
    const known = this.catalog
      .find((c) => c.externalId === carrierExternalId)
      ?.services.some((s) => s.code === code);
    if (prefix !== "se-rate" || !known || !amount) {
      throw shippingErrorFromStatus("purchaseLabel", 400, "rate_not_found");
    }
    const id = `se-label-${crypto.randomUUID()}`;
    return this.label(
      this.newLabel(input, {
        providerLabelId: id,
        providerShipmentId: input.rate.providerShipmentId,
        costCents: Number(amount),
        document: { url: `data:application/pdf;base64,${btoa(fakeLabelPdf(id))}` },
      }),
    );
  }

  async findLabel(idempotencyKey: string): Promise<PurchasedLabel | null> {
    await this.request({ operation: "findLabel" });
    const label = this.labels.get(idempotencyKey);
    return label ? this.label(label) : null;
  }

  /** Declines a label that is already voided, as ShipStation answers `approved: false`. */
  async voidLabel(providerLabelId: string): Promise<{ approved: boolean; message?: string }> {
    await this.request({ operation: "voidLabel" });
    const label = [...this.labels.values()].find((l) => l.providerLabelId === providerLabelId);
    if (label?.voided) return { approved: false, message: "Label already voided." };
    if (label) label.voided = true;
    return { approved: true };
  }
}

/** Shaped like Bridge Source's REST and CORE APIs. */
export class FakeBridgeSourceProvider extends FakeProvider {
  readonly id = "BRIDGE_SOURCE" as const;
  readonly capabilities = {
    addressValidation: false,
    labelLookup: false,
    void: true,
    manifests: true,
  };

  constructor(options: FakeProviderOptions = {}) {
    super(
      [
        {
          externalId: "DEMOGND",
          name: "Demo Ground",
          services: [
            service("GND", "Demo Ground", "domestic", 430, 13, 5),
            service("GNDECO", "Demo Ground Economy", "domestic", 410, 13, 8),
          ],
        },
        {
          externalId: "DEMOEXP",
          name: "Demo Express",
          services: [
            service("EXP", "Demo Express", "domestic", 1290, 18, 2, true),
            service("EXPINTL", "Demo Express International", "international", 3050, 42, 6),
          ],
        },
      ],
      options,
    );
  }

  protected override providerData(): Record<string, unknown> {
    return { packageTypeCode: "CUSTOM" };
  }

  /** One quote per service, a few at a time; quotes carry no rate id, estimate or expiry. */
  async getRates(request: RateRequest): Promise<ProviderRate[]> {
    const rates: ProviderRate[] = [];
    const queue = [...request.services];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const rate = await this.#quote(request, next);
        if (rate) rates.push(rate);
      }
    };
    await Promise.all(Array.from({ length: BRIDGE_QUOTE_CONCURRENCY }, worker));
    return rates;
  }

  async #quote(
    request: RateRequest,
    { carrierExternalId, code, providerData }: RateRequest["services"][number],
  ): Promise<ProviderRate | null> {
    await this.request({ operation: "getRates", carrierExternalId, serviceCode: code });
    if (!providerData.packageTypeCode) {
      throw shippingErrorFromStatus("getRates", 422, "PACKAGE_TYPE_REQUIRED");
    }
    const match = this.service(request, carrierExternalId, code);
    if (!match) return null;
    return {
      carrierExternalId,
      serviceCode: code,
      serviceName: match.service.name,
      amountCents: this.price(match.service, request),
      currency: "USD",
      guaranteed: match.service.guaranteed,
      trackable: true,
    };
  }

  /** Books from the full shipment; the label PDF comes back as bytes. */
  async purchaseLabel(input: PurchaseInput): Promise<PurchasedLabel> {
    await this.request({ operation: "purchaseLabel" });
    const match = this.service(
      input.shipment,
      input.rate.carrierExternalId,
      input.rate.serviceCode,
    );
    if (!match || !input.rate.providerData.packageTypeCode) {
      throw shippingErrorFromStatus("purchaseLabel", 422, "INVALID_SERVICE");
    }
    const bookNumber = `BS${digits(10)}`;
    return this.label(
      this.newLabel(input, {
        providerLabelId: bookNumber,
        costCents: this.price(match.service, input.shipment),
        document: { pdf: new TextEncoder().encode(fakeLabelPdf(bookNumber)) },
      }),
    );
  }

  async voidLabel(providerLabelId: string): Promise<{ approved: boolean; message?: string }> {
    await this.request({ operation: "voidLabel" });
    const label = [...this.labels.values()].find((l) => l.providerLabelId === providerLabelId);
    if (label) label.voided = true;
    return { approved: true };
  }
}

/** Builds the fake standing in for a provider's adapter. */
export function createFakeShippingProvider(
  id: ProviderId,
  options: FakeProviderOptions = {},
): FakeShipStationProvider | FakeBridgeSourceProvider {
  return id === "SHIPSTATION"
    ? new FakeShipStationProvider(options)
    : new FakeBridgeSourceProvider(options);
}

export function isFakeShippingProvider(provider: ShippingProvider): boolean {
  return provider instanceof FakeProvider;
}

function service(
  code: string,
  name: string,
  scope: "domestic" | "international",
  baseCents: number,
  perOzCents: number,
  days: number,
  guaranteed = false,
): CatalogService {
  return {
    code,
    name,
    domestic: scope === "domestic",
    international: scope === "international",
    baseCents,
    perOzCents,
    days,
    guaranteed,
  };
}

function digits(count: number): string {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join("");
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** A one-page PDF reading "FAKE LABEL <id>", small but valid enough for a viewer. */
export function fakeLabelPdf(id: string): string {
  const text = `FAKE LABEL ${id}`.replace(/[()\\]/g, "");
  const stream = `BT /F1 18 Tf 36 200 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
