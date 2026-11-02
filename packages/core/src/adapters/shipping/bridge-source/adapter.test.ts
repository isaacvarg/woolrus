import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeShippingProvider, type SimulatedFailure } from "../contract";
import { ShippingError } from "../errors";
import type { RateRequest } from "../provider";
import { buildShippingProvider, shippingAdapterAvailable } from "../registry";
import error401 from "./__fixtures__/error-401.json" with { type: "json" };
import error403 from "./__fixtures__/error-403.json" with { type: "json" };
import error422 from "./__fixtures__/error-422.json" with { type: "json" };
import error422Address from "./__fixtures__/error-422-address.json" with { type: "json" };
import error422NotOffered from "./__fixtures__/error-422-not-offered.json" with { type: "json" };
import error500 from "./__fixtures__/error-500.json" with { type: "json" };
import services from "./__fixtures__/services.json" with { type: "json" };
import { BridgeSourceAdapter } from "./adapter";

const apiKey = "TEST_bridge_key_4c2d19";
const customerId = "TEST-CUSTOMER-77";
const baseUrl = "https://bridge.test";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const errorBodies = { 400: error422, 401: error401, 429: error500, 500: error500 };

/** `POST …/quote` answers by service code; anything else gets a default. */
const quotes: Record<string, unknown> = {
  A_GROUND: { totalAmount: 8.5 },
  A_EXPRESS_INTL: { totalAmount: 41.995 },
  R1: { totalAmount: 1.005 },
  R2: { totalAmount: 0.285 },
  R3: { totalAmount: 19.999 },
};
const quoteRoute = `POST /restapi/v1/customers/${customerId}/quote`;

const address = {
  name: "Quote Customer",
  address1: "1 Quote Street",
  city: "Springfield",
  state: "OR",
  postalCode: "97477",
  country: "US",
};

function rateRequest(services: RateRequest["services"], weightOz = 22.5): RateRequest {
  return {
    orderNumber: "Q-1",
    shipFrom: { ...address, name: "Warehouse" },
    shipTo: address,
    residential: true,
    package: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz },
    items: [{ sku: "SKU-1", name: "Thing", quantity: 1 }],
    services,
  };
}

const service = (code: string, carrier = "CARRIER_A", packageTypeCode: string | null = "PKG") => ({
  carrierExternalId: carrier,
  code,
  providerData: {
    serviceName: code === "A_GROUND" ? "A Ground" : `Service ${code}`,
    ...(packageTypeCode && { packageTypeCode }),
  },
});

type Call = { method: string; url: URL; headers: Headers };

/** Bridge Source's REST API played back from the fixtures. */
function fixtureApi(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const bodies: Record<string, unknown>[] = [];
  const failures: SimulatedFailure[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ method, url, headers: new Headers(init.headers) });
    const failure = failures.shift();
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (failure) return json(errorBodies[failure], failure === 400 ? 404 : failure);
    const route = `${method} ${url.pathname}`;
    const override = overrides[route];
    if (override) return override();
    if (method === "GET" && url.pathname.endsWith(`/restapi/v1/customers/${customerId}/services`)) {
      return json(services);
    }
    if (method === "POST" && url.pathname.endsWith(`/restapi/v1/customers/${customerId}/quote`)) {
      const body = JSON.parse(String(init.body)) as { serviceCode: string };
      bodies.push(body);
      return json(quotes[body.serviceCode] ?? { totalAmount: 12.34 });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch, calls, bodies, failNext: (f: SimulatedFailure) => failures.push(f) };
}

function setup(overrides?: Record<string, () => Response>, config: Record<string, unknown> = {}) {
  const api = fixtureApi(overrides);
  const provider = new BridgeSourceAdapter(
    { apiKey, customerId },
    { baseUrl, ...config },
    { fetch: api.fetch },
  );
  return { ...api, provider };
}

const servicesRoute = `GET /restapi/v1/customers/${customerId}/services`;

async function rejection(promise: Promise<unknown>): Promise<ShippingError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof ShippingError)) throw new Error(`expected a ShippingError, got ${error}`);
  return error;
}

describeShippingProvider(
  "BridgeSourceAdapter",
  () => {
    const { provider, failNext } = setup();
    return { provider, failNext, secrets: [apiKey, customerId] };
  },
  { buys: false },
);

describe("BridgeSourceAdapter", () => {
  it("sends the RSIS key to the customer's service list under the base URL", async () => {
    const { provider, calls } = setup(undefined, { baseUrl: "https://bridge.test/api/" });
    await provider.ping();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe(
      `https://bridge.test/api/restapi/v1/customers/${customerId}/services`,
    );
    expect(calls[0]?.headers.get("authorization")).toBe(`RSIS ${apiKey}`);
  });

  it("refuses without a base URL, making no request", async () => {
    const { provider, calls } = setup(undefined, { baseUrl: undefined });
    expect((await rejection(provider.ping())).kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("treats a 2xx whose body doesn't parse as unavailable, not ok", async () => {
    const { provider } = setup({ [servicesRoute]: () => json({ unexpected: true }) });
    const error = await rejection(provider.ping());
    expect(error).toMatchObject({ kind: "unavailable", detail: "ping malformed" });
    const text = new Response("<html>", { status: 200 });
    const bad = setup({ [servicesRoute]: () => text });
    expect((await rejection(bad.provider.listCarriers())).kind).toBe("unavailable");
  });

  describe("listCarriers", () => {
    it("groups by carrier code, skips inbound services and carriers left with none", async () => {
      const carriers = await setup().provider.listCarriers();
      expect(carriers.map((c) => c.externalId)).toEqual(["CARRIER_A", "CARRIER_B"]);
      expect(carriers[0]).toMatchObject({ code: "CARRIER_A", name: "Carrier A" });
      expect(carriers[0]?.services.map((s) => s.code)).toEqual(["A_GROUND", "A_EXPRESS_INTL"]);
      // no carrier name on its services: the code stands in
      expect(carriers[1]?.name).toBe("Carrier B");
    });

    it("keeps the custom-packaging package type and the country lists as provider data", async () => {
      const [a, b] = await setup().provider.listCarriers();
      expect(a?.services[0]?.providerData).toEqual({
        serviceName: "A Ground",
        packageTypeCode: "A_CUSTOM",
        supportedCountries: ["US"],
        unsupportedCountries: [],
      });
      expect(b?.services[0]?.providerData).toMatchObject({
        serviceName: "B World",
        packageTypeCode: "B_CUSTOM",
        unsupportedCountries: ["CU", "KP"],
      });
      // listed, but without a package type: getRates skips it
      expect(b?.services[1]?.providerData).not.toHaveProperty("packageTypeCode");
    });

    it("derives domestic and international from the country lists", async () => {
      const [a, b] = await setup().provider.listCarriers();
      const lane = (code: string) => {
        const s = [...(a?.services ?? []), ...(b?.services ?? [])].find((x) => x.code === code);
        return { domestic: s?.domestic, international: s?.international };
      };
      expect(lane("A_GROUND")).toEqual({ domestic: true, international: false });
      expect(lane("A_EXPRESS_INTL")).toEqual({ domestic: true, international: true });
      expect(lane("B_WORLD")).toEqual({ domestic: true, international: true });
      expect(
        (
          await setup({
            [servicesRoute]: () =>
              json([
                {
                  carrierCode: "X",
                  serviceCode: "X_OUT",
                  serviceName: "Out only",
                  supportedCountries: ["CA"],
                },
                {
                  carrierCode: "X",
                  serviceCode: "X_NO_US",
                  serviceName: "No US",
                  unsupportedCountries: ["us"],
                },
              ]),
          }).provider.listCarriers()
        )[0]?.services.map((s) => [s.domestic, s.international]),
      ).toEqual([
        [false, true],
        [false, true],
      ]);
    });
  });

  describe("errors", () => {
    const cases: [number, unknown, string, boolean][] = [
      [401, error401, "unauthorized", true],
      [403, error403, "unauthorized", true],
      [422, error422, "rejected", true],
      [422, error422NotOffered, "notOffered", true],
      [422, error422Address, "addressRejected", true],
      [404, { error: "x" }, "rejected", true],
      [405, { error: "x" }, "rejected", true],
      [415, { error: "x" }, "rejected", true],
      [500, error500, "unavailable", false],
      [503, error500, "unavailable", false],
      [429, {}, "unavailable", false],
    ];
    it.each(cases)("maps %s %#", async (status, body, kind, permanent) => {
      const { provider } = setup({ [servicesRoute]: () => json(body, status) });
      const error = await rejection(provider.ping());
      expect(error).toMatchObject({ kind, permanent, status });
      expect(error.detail).not.toContain("Request refused");
    });

    it("keeps the error category as the 422 detail, and nothing free-form", async () => {
      const { provider } = setup({
        [servicesRoute]: () =>
          json(
            { error: "bad address 742 Evergreen Terrace", errorCategory: "ADDRESS_INVALID" },
            422,
          ),
      });
      const error = await rejection(provider.ping());
      expect(error.detail).toBe("ping 422 ADDRESS_INVALID");
      const free = setup({
        [servicesRoute]: () => json({ errorCategory: "free text with spaces 742 Evergreen" }, 422),
      });
      expect((await rejection(free.provider.ping())).detail).toBe("ping 422");
    });
  });

  describe("getRates", () => {
    it("quotes each requested service with the custom package, converting units at the boundary", async () => {
      const { provider, bodies, calls } = setup();
      const rates = await provider.getRates(
        rateRequest([service("A_GROUND", "CARRIER_A", "A_CUSTOM"), service("A_EXPRESS_INTL")]),
      );
      expect(rates).toEqual([
        {
          carrierExternalId: "CARRIER_A",
          serviceCode: "A_GROUND",
          serviceName: "A Ground",
          amountCents: 850,
          currency: "USD",
          guaranteed: false,
          trackable: true,
        },
        expect.objectContaining({ serviceCode: "A_EXPRESS_INTL", amountCents: 4200 }),
      ]);
      expect(rates[0]).not.toHaveProperty("providerRateId");
      expect(rates[0]).not.toHaveProperty("expiresAt");
      expect(calls.every((c) => c.headers.get("authorization") === `RSIS ${apiKey}`)).toBe(true);
      expect(bodies[0]).toMatchObject({
        carrierCode: "CARRIER_A",
        serviceCode: "A_GROUND",
        packageTypeCode: "A_CUSTOM",
        residential: true,
        weight: { pounds: 1, ounces: 6.5 },
        dimensions: { length: 10, width: 8, height: 4 },
      });
    });

    it("rounds money half up to whole cents", async () => {
      const rates = await setup().provider.getRates(
        rateRequest(["R1", "R2", "R3"].map((c) => service(c))),
      );
      expect(rates.map((r) => r.amountCents)).toEqual([101, 29, 2000]);
    });

    it("skips a service with no custom package type, without a request", async () => {
      const { provider, bodies } = setup();
      const rates = await provider.getRates(
        rateRequest([service("A_GROUND"), service("B_NO_CUSTOM", "CARRIER_B", null)]),
      );
      expect(rates.map((r) => r.serviceCode)).toEqual(["A_GROUND"]);
      expect(bodies).toHaveLength(1);
    });

    it("drops a service Bridge Source refuses and keeps the rest", async () => {
      let n = 0;
      const { provider } = setup({
        [quoteRoute]: () => (++n === 2 ? json(error422NotOffered, 422) : json({ totalAmount: 5 })),
      });
      const rates = await provider.getRates(
        rateRequest([service("S1"), service("S2"), service("S3")]),
      );
      expect(rates).toHaveLength(2);
    });

    it("fails with the refusal when every service is refused", async () => {
      const { provider } = setup({ [quoteRoute]: () => json(error422NotOffered, 422) });
      const error = await rejection(provider.getRates(rateRequest([service("S1"), service("S2")])));
      expect(error).toMatchObject({ kind: "notOffered", status: 422 });
    });

    it("fails the whole call on any other failure", async () => {
      let n = 0;
      const { provider } = setup({
        [quoteRoute]: () => (++n === 2 ? json(error500, 500) : json({ totalAmount: 5 })),
      });
      const error = await rejection(provider.getRates(rateRequest([service("S1"), service("S2")])));
      expect(error.kind).toBe("unavailable");
    });

    it("treats a quote body that doesn't parse as unavailable", async () => {
      const { provider } = setup({ [quoteRoute]: () => json({ nope: 1 }) });
      expect(await rejection(provider.getRates(rateRequest([service("S1")])))).toMatchObject({
        kind: "unavailable",
        detail: "getRates malformed",
      });
    });

    it("refuses without a base URL, making no request", async () => {
      const { provider, calls } = setup(undefined, { baseUrl: undefined });
      expect((await rejection(provider.getRates(rateRequest([service("S1")])))).kind).toBe(
        "rejected",
      );
      expect(calls).toHaveLength(0);
    });

    it("makes at most 4 calls at once and finishes inside the budget", async () => {
      let active = 0;
      let peak = 0;
      const fetch: typeof globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return json({ totalAmount: 3 });
      };
      const provider = new BridgeSourceAdapter({ apiKey, customerId }, { baseUrl }, { fetch });
      const codes = Array.from({ length: 10 }, (_, i) => `S${i}`);
      const started = Date.now();
      const rates = await provider.getRates(rateRequest(codes.map((c) => service(c))));
      expect(rates.map((r) => r.serviceCode)).toEqual(codes);
      expect(peak).toBe(4);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("times the whole set against one budget", async () => {
      const fetch: typeof globalThis.fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      const provider = new BridgeSourceAdapter(
        { apiKey, customerId },
        { baseUrl },
        { fetch, timeoutMs: 50 },
      );
      const codes = Array.from({ length: 10 }, (_, i) => `S${i}`);
      const started = Date.now();
      const error = await rejection(provider.getRates(rateRequest(codes.map((c) => service(c)))));
      expect(error.kind).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  it("buys only when booking is enabled, and still not here (stage 1)", async () => {
    expect(setup(undefined, { bookingEnabled: true }).provider.capabilities.purchase).toBe(true);
    expect(setup(undefined, { bookingEnabled: "yes" }).provider.capabilities.purchase).toBe(false);
  });

  it("refuses to buy, without any request", async () => {
    const { provider, calls } = setup();
    expect(provider.capabilities.purchase).toBe(false);
    await expect(provider.purchaseLabel()).rejects.toMatchObject({
      kind: "rejected",
      detail: "bookingDisabled",
    });
    expect(calls).toHaveLength(0);
  });

  it("has no optional methods, and capabilities that say so", () => {
    const { provider } = setup();
    expect(provider.capabilities).toMatchObject({
      addressValidation: false,
      labelLookup: false,
      void: false,
      manifests: false,
    });
  });

  describe("registry", () => {
    // CI exports SHIPPING_PROVIDERS=fake for Playwright; this test is about the real factory.
    beforeEach(() => vi.stubEnv("SHIPPING_PROVIDERS", ""));
    afterEach(() => vi.unstubAllEnvs());

    it("is available, and built from credentials and the base URL", async () => {
      expect(shippingAdapterAvailable("BRIDGE_SOURCE")).toBe(true);
      const provider = buildShippingProvider("BRIDGE_SOURCE", { apiKey, customerId }, { baseUrl });
      expect(provider).toBeInstanceOf(BridgeSourceAdapter);
      expect(buildShippingProvider("BRIDGE_SOURCE", { apiKey }, { baseUrl })).toBeNull();
    });
  });

  describe("fixtures", () => {
    const dir = new URL("./__fixtures__/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

    it("hold no key, customer id or real-looking host", () => {
      for (const file of files) {
        const text = readFileSync(new URL(file, dir), "utf8");
        expect(text, file).not.toContain(apiKey);
        expect(text, file).not.toContain(customerId);
        expect(text, file).not.toMatch(/https?:\/\//);
        expect(text, file).not.toMatch(/Evergreen/);
      }
    });
  });
});
