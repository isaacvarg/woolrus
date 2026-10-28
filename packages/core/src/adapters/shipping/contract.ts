import { beforeEach, describe, expect, it } from "vitest";
import { ShippingError, type ShippingErrorKind } from "./errors";
import type { ProviderRate, RateRequest, ShipAddress, ShippingProvider } from "./provider";

// What every ShippingProvider must do (SPEC-carriers success criterion 1), run against both fakes,
// against the ShipStation adapter on its fixtures, and by `bridge-source` against its adapter, so
// a fake can't drift from a real provider.

/** A failure of the provider's transport: an HTTP status, a network error or a timeout. */
export type SimulatedFailure = 400 | 401 | 429 | 500 | "network" | "timeout";

export type ProviderFixture = {
  provider: ShippingProvider;
  /** Makes the provider's next request fail the way its transport would. */
  failNext(failure: SimulatedFailure): void;
  /** Credential values, which must never appear in an error. */
  secrets: string[];
};

export const contractShipFrom: ShipAddress = {
  name: "Woolrus Warehouse",
  company: "Woolrus",
  phone: "5555550100",
  address1: "100 Contract Way",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

export const contractShipTo: ShipAddress = {
  name: "Contract Customer",
  address1: "742 Evergreen Terrace",
  city: "Springfield",
  state: "OR",
  postalCode: "97477",
  country: "US",
};

const expectedFailures: [SimulatedFailure, ShippingErrorKind, boolean][] = [
  [401, "unauthorized", true],
  [400, "rejected", true],
  [429, "unavailable", false],
  [500, "unavailable", false],
  ["network", "unavailable", false],
  ["timeout", "timeout", false],
];

export function describeShippingProvider(
  name: string,
  setup: () => ProviderFixture | Promise<ProviderFixture>,
) {
  describe(`${name} (ShippingProvider)`, () => {
    let fixture: ProviderFixture;
    let provider: ShippingProvider;

    beforeEach(async () => {
      fixture = await setup();
      provider = fixture.provider;
    });

    async function domesticRequest(): Promise<RateRequest> {
      const carriers = await provider.listCarriers();
      return {
        orderNumber: "CONTRACT-1001",
        shipFrom: contractShipFrom,
        shipTo: contractShipTo,
        residential: true,
        package: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 22.5 },
        items: [{ sku: "SKU-1", name: "Contract item", quantity: 2 }],
        services: carriers.flatMap((carrier) =>
          carrier.services
            .filter((service) => service.domestic)
            .map((service) => ({
              carrierExternalId: carrier.externalId,
              code: service.code,
              providerData: service.providerData,
            })),
        ),
      };
    }

    async function purchase(request: RateRequest, rate: ProviderRate, idempotencyKey: string) {
      const service = request.services.find(
        (s) => s.carrierExternalId === rate.carrierExternalId && s.code === rate.serviceCode,
      );
      return provider.purchaseLabel({
        rate: {
          providerRateId: rate.providerRateId,
          providerShipmentId: rate.providerShipmentId,
          carrierExternalId: rate.carrierExternalId,
          serviceCode: rate.serviceCode,
          providerData: service?.providerData ?? {},
        },
        shipment: request,
        idempotencyKey,
        reference: request.orderNumber,
        format: "pdf",
        size: "4x6",
      });
    }

    it("has an optional method exactly when it has the capability", () => {
      expect(typeof provider.validateAddress === "function").toBe(
        provider.capabilities.addressValidation,
      );
      expect(typeof provider.findLabel === "function").toBe(provider.capabilities.labelLookup);
      expect(typeof provider.voidLabel === "function").toBe(provider.capabilities.void);
    });

    it("pings with accepted credentials", async () => {
      await expect(provider.ping()).resolves.toBeUndefined();
    });

    it("lists carriers, each with services that say where they ship", async () => {
      const carriers = await provider.listCarriers();
      expect(carriers.length).toBeGreaterThan(0);
      expect(new Set(carriers.map((c) => c.externalId)).size).toBe(carriers.length);
      for (const carrier of carriers) {
        expect(carrier.externalId).not.toBe("");
        expect(carrier.name).not.toBe("");
        expect(carrier.services.length).toBeGreaterThan(0);
        expect(new Set(carrier.services.map((s) => s.code)).size).toBe(carrier.services.length);
        for (const service of carrier.services) {
          expect(service.code).not.toBe("");
          expect(service.name).not.toBe("");
          expect(typeof service.domestic).toBe("boolean");
          expect(typeof service.international).toBe("boolean");
          expect(service.providerData).toBeTypeOf("object");
        }
      }
    });

    it("quotes requested services in cents, with days and dates in our types", async () => {
      const request = await domesticRequest();
      expect(request.services.length).toBeGreaterThan(0);
      const rates = await provider.getRates(request);
      expect(rates.length).toBeGreaterThan(0);
      const requested = new Set(request.services.map((s) => `${s.carrierExternalId}/${s.code}`));
      for (const rate of rates) {
        expect(requested).toContain(`${rate.carrierExternalId}/${rate.serviceCode}`);
        expect(Number.isInteger(rate.amountCents)).toBe(true);
        expect(rate.amountCents).toBeGreaterThan(0);
        expect(rate.currency).toMatch(/^[A-Z]{3}$/);
        expect(rate.serviceName).not.toBe("");
        expect(typeof rate.guaranteed).toBe("boolean");
        expect(typeof rate.trackable).toBe("boolean");
        if (rate.deliveryDays !== undefined) expect(Number.isInteger(rate.deliveryDays)).toBe(true);
        if (rate.estimatedDeliveryAt !== undefined) {
          expect(rate.estimatedDeliveryAt).toBeInstanceOf(Date);
          expect(Number.isNaN(rate.estimatedDeliveryAt.getTime())).toBe(false);
        }
        if (rate.expiresAt !== undefined) {
          expect(rate.expiresAt).toBeInstanceOf(Date);
          expect(Number.isNaN(rate.expiresAt.getTime())).toBe(false);
        }
      }
    });

    it("validates an address when it can", async (ctx) => {
      if (!provider.validateAddress) return ctx.skip();
      const check = await provider.validateAddress(contractShipTo);
      expect(["verified", "corrected", "warning", "error"]).toContain(check.status);
      expect(Array.isArray(check.messages)).toBe(true);
      if (check.address) expect(check.address.country).toMatch(/^[A-Z]{2}$/);
      if (check.residential !== undefined) expect(typeof check.residential).toBe("boolean");
    });

    it("buys a label for a quoted rate, from the rate and the shipment", async () => {
      const request = await domesticRequest();
      const [rate] = await provider.getRates(request);
      if (!rate) throw new Error("no rate to buy");
      const label = await purchase(request, rate, `contract-${crypto.randomUUID()}`);
      expect(label.providerLabelId).not.toBe("");
      expect(label.trackingNumber).not.toBe("");
      expect(label.serviceCode).not.toBe("");
      expect(label.currency).toMatch(/^[A-Z]{3}$/);
      if (label.costCents !== undefined) expect(Number.isInteger(label.costCents)).toBe(true);
      expect(label.shipDate).toBeInstanceOf(Date);
      if ("pdf" in label.document) expect(label.document.pdf.byteLength).toBeGreaterThan(0);
      // A fake's URL is a data: URL, so `qa` can fetch it like a provider's.
      else expect(label.document.url).toMatch(/^(https:\/\/|data:application\/pdf;base64,)/);
    });

    it("finds a bought label by its idempotency key when it can", async (ctx) => {
      if (!provider.findLabel) return ctx.skip();
      const request = await domesticRequest();
      const [rate] = await provider.getRates(request);
      if (!rate) throw new Error("no rate to buy");
      const key = `contract-${crypto.randomUUID()}`;
      const label = await purchase(request, rate, key);
      const found = await provider.findLabel(key);
      expect(found?.providerLabelId).toBe(label.providerLabelId);
      expect(found?.trackingNumber).toBe(label.trackingNumber);
      expect(await provider.findLabel(`contract-${crypto.randomUUID()}`)).toBeNull();
    });

    it("voids a label, answering whether the provider approved", async (ctx) => {
      if (!provider.voidLabel) return ctx.skip();
      const request = await domesticRequest();
      const [rate] = await provider.getRates(request);
      if (!rate) throw new Error("no rate to buy");
      const label = await purchase(request, rate, `contract-${crypto.randomUUID()}`);
      const result = await provider.voidLabel(label.providerLabelId);
      expect(typeof result.approved).toBe("boolean");
    });

    describe.each(expectedFailures)("a %s failure", (failure, kind, permanent) => {
      it(`is a ${permanent ? "permanent" : "transient"} ${kind} ShippingError with a clean detail`, async () => {
        const request = await domesticRequest();
        for (const call of [() => provider.ping(), () => provider.getRates(request)]) {
          fixture.failNext(failure);
          const error = await call().then(
            () => null,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(ShippingError);
          expect(error).toMatchObject({ kind, permanent, messageKey: `errors.shipping.${kind}` });
          const text = `${(error as ShippingError).detail ?? ""} ${(error as Error).message}`;
          for (const secret of fixture.secrets) expect(text).not.toContain(secret);
          for (const address of [contractShipFrom, contractShipTo]) {
            for (const value of [address.name, address.address1, address.postalCode]) {
              expect(text).not.toContain(value);
            }
          }
        }
      });
    });
  });
}
