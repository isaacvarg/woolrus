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

/** A provider error code worth logging: one short token, so it can't carry free text. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Quotes in flight at once: the provider's own limit on concurrent calls. */
const QUOTE_CONCURRENCY = 4;

/** Dollars to whole cents, half up; the precision cut absorbs binary noise (0.285 * 100 = 28.499…). */
const toCents = (amount: number) => Math.round(Number((amount * 100).toPrecision(12)));

/** Ounces to the pounds-and-ounces split the quote takes. */
function weight(totalOz: number) {
  const pounds = Math.floor(totalOz / 16);
  return { pounds, ounces: Math.round((totalOz - pounds * 16) * 100) / 100 };
}

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
        name: service.carrierName || service.carrierCode,
        services: new Map<string, ProviderService>(),
      };
      carriers.set(service.carrierCode, carrier);
      if (carrier.services.has(service.serviceCode)) continue;
      const custom = service.packageTypes?.find((p) => p.custom === true);
      carrier.services.set(service.serviceCode, {
        code: service.serviceCode,
        name: service.serviceName,
        ...lanes(service),
        providerData: {
          serviceName: service.serviceName,
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
   * One `POST …/quote` per requested service with a custom package type (the rest are skipped: no
   * package to rate), at most `QUOTE_CONCURRENCY` at once, all inside one provider budget. A service
   * Bridge Source says it doesn't offer is dropped; any other failure fails the call, and so does
   * every service being refused.
   */
  async getRates(request: RateRequest): Promise<ProviderRate[]> {
    const budget = AbortSignal.timeout(this.timeoutMs);
    const quotable = request.services.filter(
      (service) => typeof service.providerData.packageTypeCode === "string",
    );
    const results: (ProviderRate | null)[] = new Array(quotable.length).fill(null);
    const refused: ShippingError[] = [];
    let next = 0;
    let failed: ShippingError | null = null;
    const worker = async () => {
      while (failed === null && next < quotable.length) {
        const index = next++;
        const service = quotable[index];
        if (!service) return;
        try {
          results[index] = await this.quote(request, service, budget);
        } catch (error) {
          if (error instanceof ShippingError && error.kind === "notOffered") refused.push(error);
          else
            failed ??=
              error instanceof ShippingError ? error : shippingErrorFromCause("getRates", error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(QUOTE_CONCURRENCY, quotable.length) }, worker));
    if (failed) throw failed;
    const rates = results.filter((rate): rate is ProviderRate => rate !== null);
    const first = refused[0];
    if (rates.length === 0 && first) throw first;
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
      {
        carrierCode: service.carrierExternalId,
        serviceCode: service.code,
        packageTypeCode: service.providerData.packageTypeCode,
        residential: request.residential,
        shipFrom: request.shipFrom,
        shipTo: request.shipTo,
        weight: weight(pack.weightOz),
        dimensions: { length: pack.lengthIn, width: pack.widthIn, height: pack.heightIn },
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
