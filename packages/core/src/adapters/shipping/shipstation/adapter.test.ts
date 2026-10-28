import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  contractShipFrom,
  contractShipTo,
  describeShippingProvider,
  type SimulatedFailure,
} from "../contract";
import { ShippingError } from "../errors";
import type { PurchaseInput, RateRequest } from "../provider";
import { buildShippingProvider } from "../registry";
import addressCorrected from "./__fixtures__/address-corrected.json" with { type: "json" };
import addressError from "./__fixtures__/address-error.json" with { type: "json" };
import addressVerified from "./__fixtures__/address-verified.json" with { type: "json" };
import addressWarning from "./__fixtures__/address-warning.json" with { type: "json" };
import carriers from "./__fixtures__/carriers.json" with { type: "json" };
import error400 from "./__fixtures__/error-400.json" with { type: "json" };
import error401 from "./__fixtures__/error-401.json" with { type: "json" };
import error429 from "./__fixtures__/error-429.json" with { type: "json" };
import error500 from "./__fixtures__/error-500.json" with { type: "json" };
import label from "./__fixtures__/label.json" with { type: "json" };
import labelsEmpty from "./__fixtures__/labels-empty.json" with { type: "json" };
import rates from "./__fixtures__/rates.json" with { type: "json" };
import ratesError from "./__fixtures__/rates-error.json" with { type: "json" };
import voidApproved from "./__fixtures__/void-approved.json" with { type: "json" };
import voidDeclined from "./__fixtures__/void-declined.json" with { type: "json" };
import { ShipStationAdapter } from "./adapter";

const apiKey = "TEST_shipstation_key_9f8e7d";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorBodies = { 400: error400, 401: error401, 429: error429, 500: error500 };

type Call = { method: string; url: URL; headers: Headers; body: unknown };

/**
 * ShipStation's v2 API played back from the fixtures. Purchases are remembered by
 * `external_shipment_id`, so a lookup finds the label bought before it, as the real API does.
 */
function fixtureApi(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const failures: SimulatedFailure[] = [];
  const bought = new Map<string, typeof label>();

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: new Headers(init.headers), body });

    const failure = failures.shift();
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (failure) return json(errorBodies[failure], failure);

    const route = `${method} ${url.pathname}`;
    const override = overrides[route];
    if (override) return override();
    if (route === "GET /v2/carriers") return json(carriers);
    if (route === "POST /v2/rates") return json(rates);
    if (route === "POST /v2/addresses/validate") return json(addressVerified);
    if (method === "POST" && url.pathname.startsWith("/v2/labels/rates/")) {
      const key = (body as { external_shipment_id: string }).external_shipment_id;
      const n = bought.size + 1;
      const made = {
        ...label,
        label_id: `se-50000${n}`,
        tracking_number: `1Z00000000000000${n}`,
        external_shipment_id: key,
      };
      bought.set(key, made);
      return json(made);
    }
    if (route === "GET /v2/labels") {
      const found = bought.get(url.searchParams.get("external_shipment_id") ?? "");
      return json(found ? { ...labelsEmpty, labels: [found], total: 1, pages: 1 } : labelsEmpty);
    }
    if (method === "PUT" && url.pathname.endsWith("/void")) return json(voidApproved);
    return json({ errors: [{ error_code: "not_found" }] }, 404);
  };

  return {
    fetch,
    calls,
    failNext: (failure: SimulatedFailure) => failures.push(failure),
  };
}

function setup(overrides?: Record<string, () => Response>) {
  const api = fixtureApi(overrides);
  return { ...api, provider: new ShipStationAdapter({ apiKey }, { fetch: api.fetch }) };
}

const request: RateRequest = {
  orderNumber: "CONTRACT-1001",
  shipFrom: contractShipFrom,
  shipTo: contractShipTo,
  residential: true,
  package: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 22.5 },
  items: [{ sku: "SKU-1", name: "Contract item", quantity: 2 }],
  services: [
    { carrierExternalId: "se-1000001", code: "ups_ground", providerData: {} },
    { carrierExternalId: "se-1000001", code: "ups_next_day_air", providerData: {} },
    { carrierExternalId: "se-1000002", code: "usps_ground_advantage", providerData: {} },
    { carrierExternalId: "se-1000002", code: "usps_priority_mail", providerData: {} },
  ],
};

const purchaseInput = (idempotencyKey = "label-key-1"): PurchaseInput => ({
  rate: {
    providerRateId: "se-3000001",
    providerShipmentId: "se-2000001",
    carrierExternalId: "se-1000001",
    serviceCode: "ups_ground",
    providerData: {},
  },
  shipment: request,
  idempotencyKey,
  reference: request.orderNumber,
  format: "pdf",
  size: "4x6",
});

async function rejection(promise: Promise<unknown>): Promise<ShippingError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof ShippingError)) throw new Error(`expected a ShippingError, got ${error}`);
  return error;
}

describeShippingProvider("ShipStationAdapter", () => {
  const { provider, failNext } = setup();
  return { provider, failNext, secrets: [apiKey] };
});

describe("ShipStation adapter", () => {
  it("is built by the registry for ShipStation credentials", () => {
    // CI runs the tests with SHIPPING_PROVIDERS=fake, which would build the fake instead.
    vi.stubEnv("SHIPPING_PROVIDERS", "");
    try {
      expect(buildShippingProvider("SHIPSTATION", { apiKey }, {})).toBeInstanceOf(
        ShipStationAdapter,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends the key in the API-Key header to api.shipstation.com", async () => {
    const { provider, calls } = setup();
    await provider.ping();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.href).toBe("https://api.shipstation.com/v2/carriers");
    expect(calls[0]?.headers.get("api-key")).toBe(apiKey);
  });

  it("lists carriers with their services, skipping a carrier that has none", async () => {
    const { provider } = setup();
    const list = await provider.listCarriers();
    // `code` is the carrier's own (ups), not the account-specific carrier id.
    expect(list.map((c) => [c.externalId, c.code, c.name])).toEqual([
      ["se-1000001", "ups", "UPS"],
      ["se-1000002", "stamps_com", "USPS"],
    ]);
    expect(list[0]?.services).toEqual([
      {
        code: "ups_ground",
        name: "UPS® Ground",
        domestic: true,
        international: false,
        providerData: { carrierCode: "ups" },
      },
      {
        code: "ups_next_day_air",
        name: "UPS Next Day Air®",
        domestic: true,
        international: false,
        providerData: { carrierCode: "ups" },
      },
      {
        code: "ups_worldwide_express",
        name: "UPS Worldwide Express®",
        domestic: false,
        international: true,
        providerData: { carrierCode: "ups" },
      },
    ]);
  });

  describe("rates", () => {
    it("asks for the enabled carriers and services with the shipment inline, in ounces and inches", async () => {
      const { provider, calls } = setup();
      await provider.getRates(request);
      const call = calls.at(-1);
      expect(call?.method).toBe("POST");
      expect(call?.url.pathname).toBe("/v2/rates");
      expect(call?.body).toEqual({
        rate_options: {
          carrier_ids: ["se-1000001", "se-1000002"],
          service_codes: [
            "ups_ground",
            "ups_next_day_air",
            "usps_ground_advantage",
            "usps_priority_mail",
          ],
          preferred_currency: "usd",
        },
        shipment: {
          validate_address: "no_validation",
          shipment_number: "CONTRACT-1001",
          ship_from: {
            name: "Woolrus Warehouse",
            company_name: "Woolrus",
            phone: "5555550100",
            address_line1: "100 Contract Way",
            city_locality: "Austin",
            state_province: "TX",
            postal_code: "78701",
            country_code: "US",
            address_residential_indicator: "no",
          },
          ship_to: {
            name: "Contract Customer",
            address_line1: "742 Evergreen Terrace",
            city_locality: "Springfield",
            state_province: "OR",
            postal_code: "97477",
            country_code: "US",
            address_residential_indicator: "yes",
          },
          items: [{ name: "Contract item", quantity: 2, sku: "SKU-1" }],
          packages: [
            {
              package_code: "package",
              weight: { value: 22.5, unit: "ounce" },
              dimensions: { unit: "inch", length: 10, width: 8, height: 4 },
            },
          ],
        },
      });
    });

    it("maps rates to cents with surcharges, drops services not asked for and invalid rates", async () => {
      const { provider } = setup();
      const result = await provider.getRates(request);
      expect(result).toEqual([
        {
          providerRateId: "se-3000001",
          providerShipmentId: "se-2000001",
          carrierExternalId: "se-1000001",
          serviceCode: "ups_ground",
          serviceName: "UPS® Ground",
          amountCents: 1339,
          currency: "USD",
          deliveryDays: 4,
          estimatedDeliveryAt: new Date("2026-10-31T23:00:00Z"),
          guaranteed: false,
          trackable: true,
        },
        {
          providerRateId: "se-3000002",
          providerShipmentId: "se-2000001",
          carrierExternalId: "se-1000001",
          serviceCode: "ups_next_day_air",
          serviceName: "UPS Next Day Air®",
          amountCents: 4810,
          currency: "USD",
          deliveryDays: 1,
          estimatedDeliveryAt: new Date("2026-10-28T10:30:00Z"),
          guaranteed: true,
          trackable: true,
        },
        {
          providerRateId: "se-3000003",
          providerShipmentId: "se-2000001",
          carrierExternalId: "se-1000002",
          serviceCode: "usps_ground_advantage",
          serviceName: "USPS Ground Advantage",
          amountCents: 729,
          currency: "USD",
          guaranteed: false,
          trackable: true,
        },
      ]);
    });

    it("makes no call when no service is enabled", async () => {
      const { provider, calls } = setup();
      expect(await provider.getRates({ ...request, services: [] })).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it("treats a rate response with status error as rejected, keeping only its code", async () => {
      const { provider } = setup({ "POST /v2/rates": () => json(ratesError) });
      const error = await rejection(provider.getRates(request));
      expect(error).toMatchObject({ kind: "rejected", permanent: true });
      expect(error.detail).toBe("getRates 200 invalid_address");
    });
  });

  describe("address validation", () => {
    it("is verified, keeping the customer's spelling, when only the case differs", async () => {
      const { provider, calls } = setup();
      const check = await provider.validateAddress(contractShipTo);
      expect(calls.at(-1)?.body).toEqual([
        {
          name: "Contract Customer",
          address_line1: "742 Evergreen Terrace",
          city_locality: "Springfield",
          state_province: "OR",
          postal_code: "97477",
          country_code: "US",
          address_residential_indicator: "unknown",
        },
      ]);
      expect(check).toEqual({
        status: "verified",
        address: contractShipTo,
        residential: true,
        messages: [],
      });
    });

    it("is corrected with the matched street and postal code, keeping our contact fields", async () => {
      const { provider } = setup({
        "POST /v2/addresses/validate": () => json(addressCorrected),
      });
      const check = await provider.validateAddress({
        ...contractShipTo,
        company: "Example Co",
        phone: "5555550199",
        address1: "100 Example Street",
        address2: "Suite 5",
      });
      expect(check).toEqual({
        status: "corrected",
        address: {
          name: "Contract Customer",
          company: "Example Co",
          phone: "5555550199",
          address1: "100 EXAMPLE ST STE 5",
          city: "SPRINGFIELD",
          state: "OR",
          postalCode: "97477-1234",
          country: "US",
        },
        residential: false,
        messages: ["Street suffix was standardized."],
      });
    });

    it("passes a warning through with the matched address", async () => {
      const { provider } = setup({ "POST /v2/addresses/validate": () => json(addressWarning) });
      const check = await provider.validateAddress(contractShipTo);
      expect(check.status).toBe("warning");
      expect(check.address?.address1).toBe("742 EVERGREEN TER");
      expect(check.residential).toBeUndefined();
      expect(check.messages).toEqual(["There was a change or addition to the street name."]);
    });

    it("is an error with no address when nothing matched", async () => {
      const { provider } = setup({ "POST /v2/addresses/validate": () => json(addressError) });
      expect(await provider.validateAddress({ ...contractShipTo, postalCode: "00000" })).toEqual({
        status: "error",
        messages: ["Invalid Postal Code"],
      });
    });

    it("caps the provider's messages it passes on, which are stored and shown", async () => {
      const long = [{ ...addressWarning[0], messages: [{ message: "x".repeat(5_000) }] }];
      const { provider } = setup({ "POST /v2/addresses/validate": () => json(long) });
      const [message] = (await provider.validateAddress(contractShipTo)).messages;
      expect(message).toHaveLength(500);
    });

    it("treats unverified as a warning", async () => {
      const unverified = [{ ...addressVerified[0], status: "unverified", matched_address: null }];
      const { provider } = setup({ "POST /v2/addresses/validate": () => json(unverified) });
      expect((await provider.validateAddress(contractShipTo)).status).toBe("warning");
    });
  });

  describe("labels", () => {
    it("refuses a label whose download isn't on a ShipStation host", async () => {
      // `qa` fetches this URL server-side: another host would be an SSRF, and maybe a leaked key.
      for (const url of [
        "https://evil.example.com/label.pdf",
        "https://shipstation.com.evil.example/label.pdf",
        "http://api.shipstation.com/v2/downloads/label.pdf",
      ]) {
        const elsewhere = { ...label, label_download: { pdf: url, href: url } };
        const { provider } = setup({
          "POST /v2/labels/rates/se-3000001": () => json(elsewhere),
        });
        expect(await rejection(provider.purchaseLabel(purchaseInput()))).toMatchObject({
          kind: "unavailable",
          detail: "purchaseLabel malformed",
        });
      }
    });

    it("buys a 4x6 PDF from the rate id with our key as the external shipment id", async () => {
      const { provider, calls } = setup();
      const bought = await provider.purchaseLabel(purchaseInput("label-key-1"));
      const call = calls.at(-1);
      expect(call?.method).toBe("POST");
      expect(call?.url.pathname).toBe("/v2/labels/rates/se-3000001");
      expect(call?.body).toEqual({
        label_format: "pdf",
        label_layout: "4x6",
        label_download_type: "url",
        validate_address: "no_validation",
        external_shipment_id: "label-key-1",
      });
      expect(bought).toEqual({
        providerLabelId: "se-500001",
        providerShipmentId: "se-2000001",
        trackingNumber: "1Z000000000000001",
        carrierCode: "ups",
        serviceCode: "ups_ground",
        costCents: 1339,
        currency: "USD",
        document: { url: "https://api.shipstation.com/v2/downloads/10/fixture/label-5000001.pdf" },
        shipDate: new Date("2026-10-27T00:00:00Z"),
      });
    });

    it("refuses a rate without a rate id, or a key ShipStation would truncate, without a call", async () => {
      const { provider, calls } = setup();
      const input = purchaseInput();
      const noRate = await rejection(
        provider.purchaseLabel({ ...input, rate: { ...input.rate, providerRateId: undefined } }),
      );
      expect(noRate).toMatchObject({ kind: "rejected", detail: "purchaseLabel no rate id" });
      const longKey = await rejection(provider.purchaseLabel(purchaseInput("k".repeat(51))));
      expect(longKey).toMatchObject({ kind: "rejected", detail: "purchaseLabel key too long" });
      expect(calls).toHaveLength(0);
    });

    it("finds a label by our key, ignoring voided and failed ones", async () => {
      // qa adopts what this returns after a lost response, so a dead label must never come back.
      const voided = { ...label, status: "voided", voided: true, external_shipment_id: "k" };
      const failed = { ...label, status: "error", external_shipment_id: "k" };
      const { provider, calls } = setup({
        "GET /v2/labels": () =>
          json({ ...labelsEmpty, labels: [voided, failed], total: 2, pages: 1 }),
      });
      expect(await provider.findLabel("k")).toBeNull();
      expect(calls.at(-1)?.url.searchParams.get("external_shipment_id")).toBe("k");
    });

    it("voids by label id and returns approval", async () => {
      const { provider, calls } = setup();
      expect(await provider.voidLabel("se-5000001")).toEqual({
        approved: true,
        message: "Request for refund submitted. This label has been voided.",
      });
      expect(calls.at(-1)).toMatchObject({ method: "PUT" });
      expect(calls.at(-1)?.url.pathname).toBe("/v2/labels/se-5000001/void");
    });

    it("returns approved: false rather than throwing", async () => {
      const { provider } = setup({
        "PUT /v2/labels/se-5000001/void": () => json(voidDeclined),
      });
      expect(await provider.voidLabel("se-5000001")).toEqual({
        approved: false,
        message: "This label has already been used and cannot be voided.",
      });
    });
  });

  it("has scrubbed fixtures: no key, phone, email or account number", () => {
    const dir = new URL("./__fixtures__/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const text = readFileSync(new URL(file, dir), "utf8");
      expect(text, file).not.toMatch(/api[-_]?key"\s*:/i);
      expect(text, file).not.toMatch(/"(phone|email)"\s*:\s*"[^"]/);
      expect(text, file).not.toMatch(/"account_number"\s*:\s*"(?!X+")/);
    }
  });

  describe("errors", () => {
    it.each([
      [400, "rejected", "getRates 400 invalid_field_value"],
      [401, "unauthorized", "getRates 401 unauthorized"],
      [429, "unavailable", "getRates 429 rate_limit_exceeded"],
      [500, "unavailable", "getRates 500 unspecified"],
    ] as const)("maps %s to %s with only the error code", async (status, kind, detail) => {
      const { provider, failNext } = setup();
      failNext(status);
      const error = await rejection(provider.getRates(request));
      expect(error).toMatchObject({ kind, status, detail });
      expect(error.message).not.toContain("Evergreen");
    });

    it("maps a 2xx body it can't read to unavailable", async () => {
      const { provider } = setup({ "GET /v2/carriers": () => json({ carriers: "nope" }) });
      const error = await rejection(provider.listCarriers());
      expect(error).toMatchObject({ kind: "unavailable", detail: "listCarriers malformed" });
    });

    it("times a request out after timeoutMs", async () => {
      const provider = new ShipStationAdapter(
        { apiKey },
        {
          timeoutMs: 10,
          fetch: (_input, init) =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
            ),
        },
      );
      expect(await rejection(provider.ping())).toMatchObject({ kind: "timeout" });
    });
  });
});

// Opt-in (SPEC-carriers success criterion 17), never in CI and never buys a label:
// `SHIPSTATION_LIVE_API_KEY=… pnpm --filter @woolrus/core test -- adapters/shipping/shipstation`.
describe.skipIf(!process.env.SHIPSTATION_LIVE_API_KEY)(
  "ShipStation adapter against the live API",
  () => {
    const live = new ShipStationAdapter({ apiKey: process.env.SHIPSTATION_LIVE_API_KEY ?? "" });

    it("pings, lists carriers, validates an address and quotes rates", async () => {
      await live.ping();
      const list = await live.listCarriers();
      expect(list.length).toBeGreaterThan(0);
      const check = await live.validateAddress(contractShipTo);
      expect(["verified", "corrected", "warning", "error"]).toContain(check.status);
      const quotes = await live.getRates({
        ...request,
        services: list.flatMap((c) =>
          c.services
            .filter((s) => s.domestic)
            .map((s) => ({
              carrierExternalId: c.externalId,
              code: s.code,
              providerData: s.providerData,
            })),
        ),
      });
      expect(quotes.length).toBeGreaterThan(0);
    }, 60_000);
  },
);
