import { describe, expect, it } from "vitest";
import { contractShipFrom, contractShipTo, describeShippingProvider } from "./contract";
import { FakeBridgeSourceProvider, FakeShipStationProvider } from "./fake";
import type { RateRequest, ShippingProvider } from "./provider";

describeShippingProvider("FakeShipStationProvider", () => {
  const provider = new FakeShipStationProvider({ credentials: { apiKey: "fake-ss-key-123" } });
  return { provider, failNext: (f) => provider.failNext(f), secrets: ["fake-ss-key-123"] };
});

describeShippingProvider("FakeBridgeSourceProvider", () => {
  const provider = new FakeBridgeSourceProvider({
    credentials: { apiKey: "fake-bs-key-456", customerId: "C-98765" },
  });
  return {
    provider,
    failNext: (f) => provider.failNext(f),
    secrets: ["fake-bs-key-456", "C-98765"],
  };
});

async function request(provider: ShippingProvider, country = "US"): Promise<RateRequest> {
  const carriers = await provider.listCarriers();
  return {
    orderNumber: "1001",
    shipFrom: contractShipFrom,
    shipTo: { ...contractShipTo, country },
    residential: true,
    package: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 16.2 },
    items: [{ sku: "SKU-1", name: "Item", quantity: 1 }],
    services: carriers.flatMap((c) =>
      c.services.map((s) => ({
        carrierExternalId: c.externalId,
        code: s.code,
        providerData: s.providerData,
      })),
    ),
  };
}

describe("FakeShipStationProvider", () => {
  it("lists Demo Ground and Demo Express", async () => {
    const carriers = await new FakeShipStationProvider().listCarriers();
    expect(carriers.map((c) => c.name)).toEqual(["Demo Ground", "Demo Express"]);
  });

  it("quotes every service in one request, each with a rate id and an estimate", async () => {
    const provider = new FakeShipStationProvider();
    const req = await request(provider);
    provider.requests.length = 0;
    const rates = await provider.getRates(req);
    expect(provider.requests).toEqual([{ operation: "getRates" }]);
    expect(rates.map((r) => r.serviceCode)).toEqual([
      "demo_ground",
      "demo_ground_saver",
      "demo_express",
    ]);
    for (const rate of rates) {
      expect(rate.providerRateId).toBeTruthy();
      expect(rate.deliveryDays).toBeGreaterThan(0);
    }
    // 17 oz rounded up: 450 + 12 × 17.
    expect(rates[0]?.amountCents).toBe(654);
  });

  it("quotes only international services abroad, and drops services it doesn't know", async () => {
    const provider = new FakeShipStationProvider();
    const req = await request(provider, "CA");
    req.services.push({ carrierExternalId: "se-unknown", code: "x", providerData: {} });
    const rates = await provider.getRates(req);
    expect(rates.map((r) => r.serviceCode)).toEqual(["demo_express_intl"]);
  });

  it("buys from the rate id alone, even in another instance", async () => {
    const quoting = new FakeShipStationProvider();
    const req = await request(quoting);
    const [rate] = await quoting.getRates(req);
    const buying = new FakeShipStationProvider();
    const label = await buying.purchaseLabel({
      rate: {
        providerRateId: rate?.providerRateId,
        carrierExternalId: "ignored",
        serviceCode: "x",
        providerData: {},
      },
      shipment: req,
      idempotencyKey: "key-1",
      reference: "1001",
      format: "pdf",
      size: "4x6",
    });
    expect(label.costCents).toBe(rate?.amountCents);
    expect("url" in label.document && label.document.url.startsWith("data:application/pdf")).toBe(
      true,
    );
    await expect(
      buying.purchaseLabel({
        rate: { carrierExternalId: "se-demo-ground", serviceCode: "demo_ground", providerData: {} },
        shipment: req,
        idempotencyKey: "key-2",
        reference: "1001",
        format: "pdf",
        size: "4x6",
      }),
    ).rejects.toMatchObject({ kind: "rejected", detail: "purchaseLabel 400 rate_not_found" });
  });

  it("returns the label already bought for the same key, and shares labels it is given", async () => {
    const labels = new Map();
    const provider = new FakeShipStationProvider({ labels });
    const req = await request(provider);
    const [rate] = await provider.getRates(req);
    const input = {
      rate: {
        providerRateId: rate?.providerRateId,
        carrierExternalId: "",
        serviceCode: "",
        providerData: {},
      },
      shipment: req,
      idempotencyKey: "same-key",
      reference: "1001",
      format: "pdf" as const,
      size: "4x6" as const,
    };
    const first = await provider.purchaseLabel(input);
    expect((await provider.purchaseLabel(input)).providerLabelId).toBe(first.providerLabelId);
    const other = new FakeShipStationProvider({ labels });
    expect((await other.findLabel("same-key"))?.providerLabelId).toBe(first.providerLabelId);
  });

  it("declines to void a label twice", async () => {
    const provider = new FakeShipStationProvider();
    const req = await request(provider);
    const [rate] = await provider.getRates(req);
    const label = await provider.purchaseLabel({
      rate: {
        providerRateId: rate?.providerRateId,
        carrierExternalId: "",
        serviceCode: "",
        providerData: {},
      },
      shipment: req,
      idempotencyKey: "void-key",
      reference: "1001",
      format: "pdf",
      size: "4x6",
    });
    expect(await provider.voidLabel(label.providerLabelId)).toEqual({ approved: true });
    expect(await provider.voidLabel(label.providerLabelId)).toMatchObject({ approved: false });
  });

  it("corrects an address line containing Street, verifies others, and fails 00000", async () => {
    const provider = new FakeShipStationProvider();
    const corrected = await provider.validateAddress({
      ...contractShipTo,
      address1: "12 Elm Street",
    });
    expect(corrected).toMatchObject({
      status: "corrected",
      residential: true,
      address: { address1: "12 Elm St" },
    });
    expect(await provider.validateAddress({ ...contractShipTo, company: "Acme" })).toMatchObject({
      status: "verified",
      residential: false,
    });
    expect(
      await provider.validateAddress({ ...contractShipTo, postalCode: "00000" }),
    ).toMatchObject({
      status: "error",
    });
  });

  it("refuses credentials set to 'invalid'", async () => {
    const provider = new FakeShipStationProvider({ credentials: { apiKey: "invalid" } });
    await expect(provider.ping()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("waits its latency on each request", async () => {
    const provider = new FakeShipStationProvider({ latencyMs: 50 });
    const started = performance.now();
    await provider.ping();
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe("FakeBridgeSourceProvider", () => {
  it("has no address validation or label lookup", () => {
    const provider: ShippingProvider = new FakeBridgeSourceProvider();
    expect(provider.validateAddress).toBeUndefined();
    expect(provider.findLabel).toBeUndefined();
    expect(provider.capabilities).toEqual({
      addressValidation: false,
      labelLookup: false,
      void: true,
      manifests: true,
    });
  });

  it("keeps its custom package type in each service's providerData", async () => {
    const carriers = await new FakeBridgeSourceProvider().listCarriers();
    expect(carriers.map((c) => c.name)).toEqual(["Demo Ground", "Demo Express"]);
    for (const s of carriers.flatMap((c) => c.services)) {
      expect(s.providerData).toEqual({ packageTypeCode: "CUSTOM" });
    }
  });

  it("quotes one service per request, with no rate id, estimate or expiry", async () => {
    const provider = new FakeBridgeSourceProvider();
    const req = await request(provider);
    provider.requests.length = 0;
    const rates = await provider.getRates(req);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests.map((r) => r.serviceCode).sort()).toEqual([
      "EXP",
      "EXPINTL",
      "GND",
      "GNDECO",
    ]);
    expect(rates.map((r) => r.serviceCode).sort()).toEqual(["EXP", "GND", "GNDECO"]);
    for (const rate of rates) {
      expect(rate.providerRateId).toBeUndefined();
      expect(rate.deliveryDays).toBeUndefined();
      expect(rate.expiresAt).toBeUndefined();
    }
  });

  it("quotes at most four services at once", async () => {
    const provider = new FakeBridgeSourceProvider({ latencyMs: 40 });
    const req = await request(provider);
    req.services = [...req.services, ...req.services]; // 8 quotes → two rounds
    const started = performance.now();
    await provider.getRates(req);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(160);
  });

  it("refuses a quote without its package type", async () => {
    const provider = new FakeBridgeSourceProvider();
    const req = await request(provider);
    req.services = req.services.map((s) => ({ ...s, providerData: {} }));
    await expect(provider.getRates(req)).rejects.toMatchObject({
      kind: "rejected",
      detail: "getRates 422 PACKAGE_TYPE_REQUIRED",
    });
  });

  it("books from the shipment without a rate id and returns the PDF bytes", async () => {
    const provider = new FakeBridgeSourceProvider();
    const req = await request(provider);
    const label = await provider.purchaseLabel({
      rate: {
        carrierExternalId: "DEMOGND",
        serviceCode: "GND",
        providerData: { packageTypeCode: "CUSTOM" },
      },
      shipment: req,
      idempotencyKey: "bs-key",
      reference: "1001",
      format: "pdf",
      size: "4x6",
    });
    expect(label.providerLabelId).toMatch(/^BS\d{10}$/);
    expect(label.costCents).toBe(430 + 13 * 17);
    expect("pdf" in label.document && new TextDecoder().decode(label.document.pdf)).toMatch(
      /^%PDF-1\.4/,
    );
  });
});
