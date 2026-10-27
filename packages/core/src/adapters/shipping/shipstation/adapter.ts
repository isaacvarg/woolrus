import type { z } from "zod";
import { ShippingError, shippingErrorFromCause, shippingErrorFromStatus } from "../errors";
import {
  type AddressCheck,
  PROVIDER_TIMEOUT_MS,
  type ProviderCarrier,
  type ProviderRate,
  type PurchasedLabel,
  type PurchaseInput,
  type RateRequest,
  type ShipAddress,
  type ShippingProvider,
} from "../provider";
import {
  carriersResponse,
  errorResponse,
  labelSchema,
  labelsResponse,
  ratesResponse,
  validateResponse,
  voidResponse,
} from "./schemas";

export type ShipStationCredentials = { apiKey: string };

export type ShipStationOptions = { fetch?: typeof fetch; timeoutMs?: number };

const BASE_URL = "https://api.shipstation.com";

/** ShipStation keeps only the first 50 characters of `external_shipment_id`. */
const MAX_EXTERNAL_ID = 50;

type Residential = "yes" | "no" | "unknown";

const cents = (money: { amount: number } | null | undefined) =>
  money ? Math.round(money.amount * 100) : 0;

/** Our address in ShipStation's shape; empty optional fields are left out. */
function toShipStation(address: ShipAddress, residential: Residential) {
  return {
    name: address.name,
    ...(address.company && { company_name: address.company }),
    ...(address.phone && { phone: address.phone }),
    ...(address.email && { email: address.email }),
    address_line1: address.address1,
    ...(address.address2 && { address_line2: address.address2 }),
    city_locality: address.city,
    state_province: address.state,
    postal_code: address.postalCode,
    country_code: address.country,
    address_residential_indicator: residential,
  };
}

const deliveryLines = (a: ShipAddress) =>
  [a.address1, a.address2 ?? "", a.city, a.state, a.postalCode, a.country].map((part) =>
    part.trim().toUpperCase(),
  );

function toLabel(label: z.output<typeof labelSchema>, operation: string): PurchasedLabel {
  const url = label.label_download.pdf ?? label.label_download.href;
  if (!url?.startsWith("https://"))
    throw new ShippingError("unavailable", `${operation} malformed`);
  return {
    providerLabelId: label.label_id,
    ...(label.shipment_id && { providerShipmentId: label.shipment_id }),
    trackingNumber: label.tracking_number,
    carrierCode: label.carrier_id,
    serviceCode: label.service_code,
    costCents: cents(label.shipment_cost) + cents(label.insurance_cost),
    currency: label.shipment_cost.currency.toUpperCase(),
    document: { url },
    shipDate: label.ship_date,
  };
}

/**
 * ShipStation API v2 over plain `fetch` (SPEC-carriers "ShipStation adapter"; no SDK, like the
 * WooCommerce and Resend adapters). UPS and every other carrier connected in the ShipStation
 * account come through it. It doesn't retry: the rate fetch job and `qa` do.
 */
export class ShipStationAdapter implements ShippingProvider {
  readonly id = "SHIPSTATION" as const;
  readonly capabilities = {
    addressValidation: true,
    labelLookup: true,
    void: true,
    manifests: true,
  };

  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: ShipStationCredentials,
    options: ShipStationOptions = {},
  ) {
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  }

  /** Any 2xx from the carrier list means the key is accepted. */
  async ping(): Promise<void> {
    await this.send("ping", "GET", "/v2/carriers");
  }

  /** Carriers with no services (not set up, or off on our plan) can't be rated, so they're left out. */
  async listCarriers(): Promise<ProviderCarrier[]> {
    const { carriers } = await this.call("listCarriers", "GET", "/v2/carriers", carriersResponse);
    return carriers.flatMap((carrier) => {
      const services = [
        ...new Map((carrier.services ?? []).map((s) => [s.service_code, s])).values(),
      ];
      if (services.length === 0) return [];
      return [
        {
          externalId: carrier.carrier_id,
          name: carrier.friendly_name || carrier.nickname || carrier.carrier_code,
          services: services.map((s) => ({
            code: s.service_code,
            name: s.name,
            domestic: s.domestic,
            international: s.international,
            providerData: { carrierCode: carrier.carrier_code },
          })),
        },
      ];
    });
  }

  /**
   * `verified` with a different delivery line (beyond letter case) is our `corrected`; ShipStation's
   * `unverified` (it couldn't check, e.g. an unsupported country) is a `warning`. The contact fields
   * stay ours, since ShipStation upper-cases them.
   */
  async validateAddress(address: ShipAddress): Promise<AddressCheck> {
    const [result] = await this.call(
      "validateAddress",
      "POST",
      "/v2/addresses/validate",
      validateResponse,
      [toShipStation(address, "unknown")],
    );
    if (!result) throw new ShippingError("unavailable", "validateAddress malformed");
    const messages = (result.messages ?? []).map((m) => m.message);
    const matched = result.matched_address;
    const indicator = matched?.address_residential_indicator;
    const residential = indicator === "yes" ? true : indicator === "no" ? false : undefined;
    const extras = residential === undefined ? {} : { residential };
    if (!matched || result.status === "error") {
      return { status: result.status === "error" ? "error" : "warning", ...extras, messages };
    }
    const normalised: ShipAddress = {
      name: address.name,
      ...(address.company && { company: address.company }),
      ...(address.phone && { phone: address.phone }),
      ...(address.email && { email: address.email }),
      address1: matched.address_line1,
      ...(matched.address_line2 && { address2: matched.address_line2 }),
      city: matched.city_locality,
      state: matched.state_province,
      postalCode: matched.postal_code,
      country: matched.country_code.toUpperCase(),
    };
    if (result.status !== "verified") {
      return { status: "warning", address: normalised, ...extras, messages };
    }
    const same = deliveryLines(normalised).join("\n") === deliveryLines(address).join("\n");
    return same
      ? { status: "verified", address, ...extras, messages }
      : { status: "corrected", address: normalised, ...extras, messages };
  }

  /**
   * One call for every enabled service. ShipStation crosses `carrier_ids` with `service_codes`, so
   * rates for pairs we didn't ask for are dropped here. A rate's price includes its surcharges.
   */
  async getRates(request: RateRequest): Promise<ProviderRate[]> {
    if (request.services.length === 0) return [];
    const unique = (values: string[]) => [...new Set(values)];
    const body = {
      rate_options: {
        carrier_ids: unique(request.services.map((s) => s.carrierExternalId)),
        service_codes: unique(request.services.map((s) => s.code)),
        preferred_currency: "usd",
      },
      shipment: {
        validate_address: "no_validation",
        shipment_number: request.orderNumber,
        ship_from: toShipStation(request.shipFrom, "no"),
        ship_to: toShipStation(request.shipTo, request.residential ? "yes" : "no"),
        items: request.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          ...(item.sku && { sku: item.sku }),
        })),
        packages: [
          {
            package_code: "package",
            weight: { value: request.package.weightOz, unit: "ounce" },
            dimensions: {
              unit: "inch",
              length: request.package.lengthIn,
              width: request.package.widthIn,
              height: request.package.heightIn,
            },
          },
        ],
      },
    };
    const response = await this.call("getRates", "POST", "/v2/rates", ratesResponse, body);
    const { rate_response: result } = response;
    if (result.status === "error") {
      // A 200 that quoted nothing: ShipStation refused the shipment (address, dimensions…).
      throw shippingErrorFromStatus("getRates", 200, result.errors?.[0]?.error_code ?? undefined);
    }
    const requested = new Set(request.services.map((s) => `${s.carrierExternalId}/${s.code}`));
    const shipmentId = result.shipment_id ?? response.shipment_id;
    return result.rates
      .filter((rate) => requested.has(`${rate.carrier_id}/${rate.service_code}`))
      .map((rate) => ({
        ...(rate.rate_id && { providerRateId: rate.rate_id }),
        ...(shipmentId && { providerShipmentId: shipmentId }),
        carrierExternalId: rate.carrier_id,
        serviceCode: rate.service_code,
        serviceName: rate.service_type,
        amountCents:
          cents(rate.shipping_amount) +
          cents(rate.insurance_amount) +
          cents(rate.confirmation_amount) +
          cents(rate.other_amount),
        currency: rate.shipping_amount.currency.toUpperCase(),
        ...(rate.delivery_days != null && { deliveryDays: rate.delivery_days }),
        ...(rate.estimated_delivery_date && { estimatedDeliveryAt: rate.estimated_delivery_date }),
        guaranteed: rate.guaranteed_service,
        trackable: rate.trackable,
      }));
  }

  /** Buys from the rate id; our idempotency key becomes the shipment's `external_shipment_id`. */
  async purchaseLabel(input: PurchaseInput): Promise<PurchasedLabel> {
    const rateId = input.rate.providerRateId;
    if (!rateId) throw new ShippingError("rejected", "purchaseLabel no rate id");
    if (input.idempotencyKey.length > MAX_EXTERNAL_ID) {
      throw new ShippingError("rejected", "purchaseLabel key too long");
    }
    const label = await this.call(
      "purchaseLabel",
      "POST",
      `/v2/labels/rates/${encodeURIComponent(rateId)}`,
      labelSchema,
      {
        label_format: input.format,
        label_layout: input.size,
        label_download_type: "url",
        validate_address: "no_validation",
        external_shipment_id: input.idempotencyKey,
      },
    );
    return toLabel(label, "purchaseLabel");
  }

  /** The live label bought with this key; a voided or failed one doesn't count. */
  async findLabel(idempotencyKey: string): Promise<PurchasedLabel | null> {
    const query = new URLSearchParams({ external_shipment_id: idempotencyKey });
    const { labels } = await this.call("findLabel", "GET", `/v2/labels?${query}`, labelsResponse);
    const label = labels.find(
      (l) =>
        l.external_shipment_id === idempotencyKey && l.status !== "voided" && l.status !== "error",
    );
    return label ? toLabel(label, "findLabel") : null;
  }

  async voidLabel(providerLabelId: string): Promise<{ approved: boolean; message?: string }> {
    const result = await this.call(
      "voidLabel",
      "PUT",
      `/v2/labels/${encodeURIComponent(providerLabelId)}/void`,
      voidResponse,
    );
    return { approved: result.approved, ...(result.message && { message: result.message }) };
  }

  private async call<Schema extends z.ZodType>(
    operation: string,
    method: string,
    path: string,
    schema: Schema,
    body?: unknown,
  ): Promise<z.output<Schema>> {
    const response = await this.send(operation, method, path, body);
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw shippingErrorFromCause(operation, error);
      }
      throw new ShippingError("unavailable", `${operation} malformed`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ShippingError("unavailable", `${operation} malformed`);
    return parsed.data;
  }

  /** The response when it's a 2xx; otherwise a `ShippingError` keeping only ShipStation's error code. */
  private async send(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          "API-Key": this.credentials.apiKey,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw shippingErrorFromCause(operation, error);
    }
    if (response.ok) return response;
    throw shippingErrorFromStatus(operation, response.status, await errorCode(response));
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorResponse.safeParse(await response.json());
    return parsed.success ? (parsed.data.errors[0]?.error_code ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}
