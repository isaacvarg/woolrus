import type { CarrierService, ShippingCarrier } from "@woolrus/db";
import { describe, expect, it } from "vitest";
import { ShippingError } from "../adapters/shipping/errors";
import type {
  AddressCheck,
  ProviderId,
  ProviderRate,
  RateRequest,
  ShipAddress,
  ShippingProvider,
} from "../adapters/shipping/provider";
import { checkAddress, type LaneProvider, quoteParcel } from "./quote";

// The shared quoting and address check, driven directly with hand-built providers: no database.

const shipTo: ShipAddress = {
  name: "Ada",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

const request: Omit<RateRequest, "services"> = {
  orderNumber: "LAB-1",
  shipFrom: { ...shipTo, name: "Warehouse", phone: "512-555-0000" },
  shipTo,
  residential: true,
  package: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 16 },
  items: [{ sku: "A", name: "A", quantity: 1 }],
};

function provider(
  id: ProviderId,
  {
    getRates = async () => [],
    validateAddress,
  }: {
    getRates?: (request: RateRequest) => Promise<ProviderRate[]>;
    validateAddress?: (address: ShipAddress) => Promise<AddressCheck>;
  } = {},
): ShippingProvider {
  return {
    id,
    capabilities: {
      purchase: true,
      addressValidation: validateAddress !== undefined,
      labelLookup: false,
      void: false,
      manifests: false,
    },
    ping: async () => {},
    listCarriers: async () => [],
    ...(validateAddress && { validateAddress }),
    getRates,
    purchaseLabel: async () => {
      throw new Error("not used");
    },
  } as unknown as ShippingProvider;
}

let nextId = 0;
function service(
  carrier: string,
  code: string,
  providerData: unknown = {},
): CarrierService & { carrier: ShippingCarrier } {
  const carrierId = `carrier-${carrier}`;
  return {
    id: `service-${nextId++}`,
    carrierId,
    code,
    providerData,
    carrier: { id: carrierId, externalId: carrier, code: carrier },
  } as unknown as CarrierService & { carrier: ShippingCarrier };
}

const rate = (carrier: string, code: string, amountCents: number): ProviderRate =>
  ({
    carrierExternalId: carrier,
    serviceCode: code,
    serviceName: code,
    amountCents,
    currency: "USD",
    guaranteed: false,
    trackable: true,
  }) as ProviderRate;

describe("quoteParcel", () => {
  it("asks each provider for its own services and matches quotes to the catalog", async () => {
    const asked: RateRequest[] = [];
    const ground = service("ups", "ground", { packageCode: "box" });
    const priority = service("usps", "priority");
    const lane: LaneProvider[] = [
      {
        provider: provider("SHIPSTATION", {
          getRates: async (r) => {
            asked.push(r);
            return [rate("ups", "ground", 900)];
          },
        }),
        services: [ground],
      },
      {
        provider: provider("BRIDGE_SOURCE", {
          getRates: async (r) => {
            asked.push(r);
            return [rate("usps", "priority", 700)];
          },
        }),
        services: [priority],
      },
    ];
    const outcomes = await quoteParcel(lane, request);
    expect(asked.map((r) => r.services)).toEqual([
      [{ carrierExternalId: "ups", code: "ground", providerData: { packageCode: "box" } }],
      [{ carrierExternalId: "usps", code: "priority", providerData: {} }],
    ]);
    expect(asked[0]).toMatchObject(request);
    expect(outcomes).toEqual([
      {
        provider: "SHIPSTATION",
        ok: true,
        rates: [
          {
            ...rate("ups", "ground", 900),
            provider: "SHIPSTATION",
            service: ground,
            carrierId: ground.carrierId,
          },
        ],
      },
      {
        provider: "BRIDGE_SOURCE",
        ok: true,
        rates: [
          {
            ...rate("usps", "priority", 700),
            provider: "BRIDGE_SOURCE",
            service: priority,
            carrierId: priority.carrierId,
          },
        ],
      },
    ]);
  });

  it("drops quotes for services that aren't on, and negative prices", async () => {
    const ground = service("ups", "ground");
    const outcomes = await quoteParcel(
      [
        {
          provider: provider("SHIPSTATION", {
            getRates: async () => [
              rate("ups", "ground", -1),
              rate("ups", "air", 2_000),
              rate("fedex", "ground", 800),
              rate("ups", "ground", 0),
            ],
          }),
          services: [ground],
        },
      ],
      request,
    );
    expect(outcomes).toMatchObject([
      { ok: true, rates: [{ serviceCode: "ground", amountCents: 0, service: ground }] },
    ]);
  });

  it("only matches a provider's quotes to its own services", async () => {
    const outcomes = await quoteParcel(
      [
        {
          provider: provider("SHIPSTATION", {
            getRates: async () => [rate("usps", "priority", 5)],
          }),
          services: [service("ups", "ground")],
        },
        { provider: provider("BRIDGE_SOURCE"), services: [service("usps", "priority")] },
      ],
      request,
    );
    expect(outcomes[0]).toEqual({ provider: "SHIPSTATION", ok: true, rates: [] });
  });

  it("fails a provider with no services without asking it", async () => {
    let asked = false;
    const outcomes = await quoteParcel(
      [
        {
          provider: provider("SHIPSTATION", {
            getRates: async () => {
              asked = true;
              return [];
            },
          }),
          services: [],
        },
      ],
      request,
    );
    expect(asked).toBe(false);
    expect(outcomes).toEqual([
      {
        provider: "SHIPSTATION",
        ok: false,
        messageKey: "errors.carriers.noCarriers",
        permanent: true,
      },
    ]);
  });

  it("turns provider failures and timeouts into rate errors, keeping the others", async () => {
    const outcomes = await quoteParcel(
      [
        {
          provider: provider("SHIPSTATION", {
            getRates: async () => {
              throw new ShippingError("unauthorized", "bad key");
            },
          }),
          services: [service("ups", "ground")],
        },
        {
          provider: provider("BRIDGE_SOURCE", { getRates: () => new Promise(() => {}) }),
          services: [service("usps", "priority")],
        },
      ],
      request,
      { timeoutMs: 10 },
    );
    expect(outcomes).toEqual([
      {
        provider: "SHIPSTATION",
        ok: false,
        messageKey: "errors.shipping.unauthorized",
        permanent: true,
      },
      {
        provider: "BRIDGE_SOURCE",
        ok: false,
        messageKey: "errors.shipping.timeout",
        permanent: false,
      },
    ]);
  });

  it("asks every provider in parallel", async () => {
    const started: ProviderId[] = [];
    const slow = (id: ProviderId) =>
      provider(id, {
        getRates: async () => {
          started.push(id);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return [];
        },
      });
    const pending = quoteParcel(
      [
        { provider: slow("SHIPSTATION"), services: [service("ups", "ground")] },
        { provider: slow("BRIDGE_SOURCE"), services: [service("usps", "priority")] },
      ],
      request,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(["SHIPSTATION", "BRIDGE_SOURCE"]);
    await pending;
  });
});

describe("checkAddress", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const corrected: ShipAddress = { ...shipTo, address1: "1 MAIN ST", postalCode: "78701-1234" };
  const validator = (check: () => Promise<AddressCheck>) =>
    provider("SHIPSTATION", { validateAddress: check });

  it.each([
    ["verified", undefined, "VERIFIED", shipTo],
    ["corrected", corrected, "CORRECTED", corrected],
    ["corrected", undefined, "WARNING", shipTo],
    ["warning", undefined, "WARNING", shipTo],
    ["error", undefined, "ERROR", shipTo],
  ] as const)("maps %s (address %o) to %s", async (status, address, expected, used) => {
    const check: AddressCheck = {
      status,
      messages: ["checked"],
      residential: false,
      ...(address && { address }),
    };
    expect(await checkAddress([validator(async () => check)], shipTo, { now })).toEqual({
      shipTo: used,
      status: expected,
      messages: ["checked"],
      checkedAt: now,
      residential: false,
    });
  });

  const unchecked = { shipTo, status: "UNCHECKED", messages: [], checkedAt: null };

  it("is unchecked when no provider validates addresses", async () => {
    expect(await checkAddress([provider("SHIPSTATION")], shipTo, { now })).toEqual(unchecked);
    expect(await checkAddress([], shipTo, { now })).toEqual(unchecked);
  });

  it("uses the first provider that validates", async () => {
    const used: string[] = [];
    const answer = (id: ProviderId) =>
      provider(id, {
        validateAddress: async () => {
          used.push(id);
          return { status: "verified", messages: [] };
        },
      });
    await checkAddress(
      [provider("SHIPSTATION"), answer("BRIDGE_SOURCE"), answer("SHIPSTATION")],
      shipTo,
      { now },
    );
    expect(used).toEqual(["BRIDGE_SOURCE"]);
  });

  it("never throws: a failure or a timeout leaves it unchecked", async () => {
    const failing = validator(async () => {
      throw new ShippingError("unavailable", "down");
    });
    expect(await checkAddress([failing], shipTo, { now })).toEqual(unchecked);
    const hanging = validator(() => new Promise(() => {}));
    expect(await checkAddress([hanging], shipTo, { now, timeoutMs: 10 })).toEqual(unchecked);
  });
});
