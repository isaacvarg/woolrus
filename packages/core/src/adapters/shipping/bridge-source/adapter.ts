import type { z } from "zod";
import { ShippingError, shippingErrorFromCause } from "../errors";
import {
  PROVIDER_TIMEOUT_MS,
  type ProviderCarrier,
  type ProviderRate,
  type ProviderService,
  type PurchasedLabel,
  type RateRequest,
  type ShippingProvider,
} from "../provider";
import { errorResponse, quoteResponse, type serviceSchema, servicesResponse } from "./schemas";

export type BridgeSourceCredentials = { apiKey: string; customerId: string };

export type BridgeSourceOptions = { fetch?: typeof fetch; timeoutMs?: number };

type Service = z.output<typeof serviceSchema>;

/** An `errorCategory` that says the service isn't available for the lane, or names the address. */
const NOT_OFFERED = /service|route|country|lane|package/i;
const ADDRESS = /address|postal|zip/i;

/** The kind a 422 is, from its category alone (the free text is never read). */
function refusal(category: string | null | undefined): ShippingError["kind"] {
  if (category && ADDRESS.test(category)) return "addressRejected";
  if (category && NOT_OFFERED.test(category)) return "notOffered";
  return "rejected";
}

/** The package type for the shipper's own box: every carrier's is `<carrier>_custom_package`. */
const CUSTOM_PACKAGE = /_custom_package$/i;

/** A provider error code worth logging: one short token, so it can't carry free text. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Quotes in flight at once: the provider's own limit on concurrent calls. */
const QUOTE_CONCURRENCY = 4;

/** Dollars to whole cents, half up; the precision cut absorbs binary noise (0.285 * 100 = 28.499…). */
const toCents = (amount: number) => Math.round(Number((amount * 100).toPrecision(12)));

/** Ounces to the quote's pounds, rounded up to hundredths so a package is never under-declared. */
const pounds = (oz: number) => String(Math.ceil(Number(((oz / 16) * 100).toPrecision(12))) / 100);

/** International quotes need a declared value of at least 1.00 (a 500 otherwise). */
const MIN_DECLARED_CENTS = 100;

/** Line values in cents to the quote's dollars, or null at home (no customs). */
function declaredValue(customs: RateRequest["customs"]): string | null {
  if (!customs) return null;
  const cents = customs.items.reduce((sum, item) => sum + item.valueCents, 0);
  return (Math.max(cents, MIN_DECLARED_CENTS) / 100).toFixed(2);
}

/** Whether a service's stored country lists allow shipping to `country`; no lists allow it. */
function servesCountry(providerData: Record<string, unknown>, country: string): boolean {
  const list = (key: string) => {
    const value = providerData[key];
    return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
  };
  const supported = list("supportedCountries");
  if (supported.length > 0 && !supported.includes(country)) return false;
  return !list("unsupportedCountries").includes(country);
}

/** Failures that would fail every other quote too, so the rest aren't asked. */
const STOPS_ALL: ShippingError["kind"][] = ["unauthorized", "timeout"];

const upper = (codes: string[] | null | undefined) => (codes ?? []).map((c) => c.toUpperCase());

/** Where a service ships, from its country lists (US supported = domestic, any other = international). */
export function lanes(service: Service): { domestic: boolean; international: boolean } {
  const supported = upper(service.supportedCountries);
  const unsupported = upper(service.unsupportedCountries);
  if (supported.length > 0) {
    return {
      domestic: supported.includes("US"),
      international: supported.some((c) => c !== "US"),
    };
  }
  return { domestic: !unsupported.includes("US"), international: true };
}

/**
 * Bridge Source over plain `fetch` (SPEC-bridge-source "The adapter"; no SDK). Every call is
 * `Authorization: RSIS <apiKey>` to `<baseUrl>/restapi/v1/customers/<customerId>/…`. Stage 1 is
 * quote-only: `getRates` quotes, `purchaseLabel` stays refused.
 */
export class BridgeSourceAdapter implements ShippingProvider {
  readonly id = "BRIDGE_SOURCE" as const;
  readonly capabilities;

  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: BridgeSourceCredentials,
    private readonly config: Record<string, unknown> = {},
    options: BridgeSourceOptions = {},
  ) {
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    // No address validation, lookup or void until booking (stage 2); `purchase` follows the account.
    this.capabilities = {
      addressValidation: false,
      labelLookup: false,
      void: false,
      manifests: false,
      purchase: config.bookingEnabled === true,
    };
  }

  /** Any 2xx from the service list whose body parses means the key and customer id are accepted. */
  async ping(): Promise<void> {
    await this.services("ping");
  }

  /** Grouped by `carrierCode`; inbound services are skipped; a carrier with none left is left out. */
  async listCarriers(): Promise<ProviderCarrier[]> {
    const services = await this.services("listCarriers");
    const carriers = new Map<string, { name: string; services: Map<string, ProviderService> }>();
    for (const service of services) {
      if (service.inbound === true) continue;
      const carrier = carriers.get(service.carrierCode) ?? {
        name: service.carrierLabel || service.carrierCode,
        services: new Map<string, ProviderService>(),
      };
      carriers.set(service.carrierCode, carrier);
      if (carrier.services.has(service.serviceCode)) continue;
      const custom = service.packageTypes?.find((p) => CUSTOM_PACKAGE.test(p.packageTypeCode));
      carrier.services.set(service.serviceCode, {
        code: service.serviceCode,
        name: service.serviceLabel,
        ...lanes(service),
        providerData: {
          serviceName: service.serviceLabel,
          ...(custom && { packageTypeCode: custom.packageTypeCode }),
          supportedCountries: upper(service.supportedCountries),
          unsupportedCountries: upper(service.unsupportedCountries),
        },
      });
    }
    return [...carriers].map(([code, carrier]) => ({
      externalId: code,
      code,
      name: carrier.name,
      billedByProvider: true,
      services: [...carrier.services.values()],
    }));
  }

  /**
   * One `POST …/quote` per requested service with a custom package type whose country lists allow
   * the destination (the rest are skipped without a request), at most `QUOTE_CONCURRENCY` at once,
   * all inside one provider budget. A service that fails is dropped while any other quotes:
   * Bridge Source answers a service it won't quote (not on the account, wrong lane) with a 500, so
   * a failed service says nothing about the rest. With no quote at all the call fails, preferring
   * a failure over a refusal; `unauthorized` and `timeout` stop the remaining quotes.
   */
  async getRates(request: RateRequest): Promise<ProviderRate[]> {
    const budget = AbortSignal.timeout(this.timeoutMs);
    const country = request.shipTo.country.toUpperCase();
    const quotable = request.services.filter(
      (service) =>
        typeof service.providerData.packageTypeCode === "string" &&
        servesCountry(service.providerData, country),
    );
    const results: (ProviderRate | null)[] = new Array(quotable.length).fill(null);
    const refused: ShippingError[] = [];
    const failures: ShippingError[] = [];
    let next = 0;
    let stopped = false;
    const worker = async () => {
      while (!stopped && next < quotable.length) {
        const index = next++;
        const service = quotable[index];
        if (!service) return;
        try {
          results[index] = await this.quote(request, service, budget);
        } catch (error) {
          const failure =
            error instanceof ShippingError ? error : shippingErrorFromCause("getRates", error);
          (failure.kind === "notOffered" ? refused : failures).push(failure);
          if (STOPS_ALL.includes(failure.kind)) stopped = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(QUOTE_CONCURRENCY, quotable.length) }, worker));
    const rates = results.filter((rate): rate is ProviderRate => rate !== null);
    const first = failures[0] ?? refused[0];
    if (first && (rates.length === 0 || stopped)) throw first;
    return rates;
  }

  private async quote(
    request: RateRequest,
    service: RateRequest["services"][number],
    signal: AbortSignal,
  ): Promise<ProviderRate> {
    const { package: pack } = request;
    const response = await this.send(
      "getRates",
      "POST",
      "/quote",
      // The quote takes only zip and country for each address, and numbers as strings.
      {
        carrierCode: service.carrierExternalId,
        serviceCode: service.code,
        packageTypeCode: service.providerData.packageTypeCode,
        signatureOptionCode: "NO_SIGNATURE_REQUIRED",
        residential: request.residential,
        currency: "USD",
        weightUnit: "lb",
        dimUnit: "in",
        sender: { zip: request.shipFrom.postalCode, country: request.shipFrom.country },
        receiver: { zip: request.shipTo.postalCode, country: request.shipTo.country },
        pieces: [
          {
            weight: pounds(pack.weightOz),
            length: String(pack.lengthIn),
            width: String(pack.widthIn),
            height: String(pack.heightIn),
            insuranceAmount: null,
            declaredValue: declaredValue(request.customs),
          },
        ],
      },
      signal,
    );
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw shippingErrorFromCause("getRates", error);
      }
      throw new ShippingError("unavailable", "getRates malformed");
    }
    const parsed = quoteResponse.safeParse(json);
    if (!parsed.success) throw new ShippingError("unavailable", "getRates malformed");
    const name = service.providerData.serviceName;
    return {
      carrierExternalId: service.carrierExternalId,
      serviceCode: service.code,
      serviceName: typeof name === "string" && name !== "" ? name : service.code,
      amountCents: toCents(parsed.data.totalAmount),
      currency: "USD",
      guaranteed: false,
      trackable: true,
    };
  }

  /** Quote-only: a backstop, never the normal path, and it makes no request. */
  async purchaseLabel(): Promise<PurchasedLabel> {
    throw new ShippingError("rejected", "bookingDisabled");
  }

  private async services(operation: string): Promise<z.output<typeof servicesResponse>> {
    const response = await this.send(operation, "GET", "/services");
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
    const parsed = servicesResponse.safeParse(json);
    if (!parsed.success) throw new ShippingError("unavailable", `${operation} malformed`);
    return parsed.data;
  }

  /** The response when it's a 2xx; otherwise a `ShippingError` keeping only the error category. */
  private async send(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    signal: AbortSignal = AbortSignal.timeout(this.timeoutMs),
  ): Promise<Response> {
    const baseUrl = typeof this.config.baseUrl === "string" ? this.config.baseUrl : "";
    if (!URL.canParse(baseUrl)) throw new ShippingError("rejected", `${operation} noBaseUrl`);
    const url = `${baseUrl.replace(/\/+$/, "")}/restapi/v1/customers/${encodeURIComponent(
      this.credentials.customerId,
    )}${path}`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: {
          Authorization: `RSIS ${this.credentials.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      throw shippingErrorFromCause(operation, error);
    }
    if (response.ok) return response;
    throw await failure(operation, response);
  }
}

async function failure(operation: string, response: Response): Promise<ShippingError> {
  const { status } = response;
  if (status === 401 || status === 403) {
    return new ShippingError("unauthorized", `${operation} ${status}`, status);
  }
  if (status === 429 || status >= 500) {
    return new ShippingError("unavailable", `${operation} ${status}`, status);
  }
  if (status !== 422) return new ShippingError("rejected", `${operation} ${status}`, status);
  let category: string | null | undefined;
  try {
    category = errorResponse.safeParse(await response.json()).data?.errorCategory;
  } catch {
    category = undefined;
  }
  const token = category && ERROR_CODE.test(category) ? ` ${category}` : "";
  return new ShippingError(refusal(category), `${operation} ${status}${token}`, status);
}
