import { randomBytes } from "node:crypto";
import type { Db, Prisma, ShippingProviderId } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type OrderSpec } from "../../test/factories";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type {
  AddressCheck,
  ProviderId,
  ProviderRate,
  RateRequest,
  ShippingProvider,
} from "../adapters/shipping/provider";
import type { AdapterFactories } from "../adapters/shipping/registry";
import { queues } from "../jobs";
import { completePack } from "../packing/complete";
import { setWeight } from "../packing/service";
import { loadSettings } from "../settings/service";
import { transition } from "../workflow/service";
import { setProviderCredentials } from "./providers";
import {
  fetchRates,
  getOrderShipping,
  RATE_TTL_HOURS,
  RatesRetryError,
  refreshRates,
  runRatesFetchJob,
} from "./rates";
import { keepOriginalAddress, recheckAddress } from "./ship-to";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.ratesFetch}`;
  await setShipFrom();
});
afterEach(() => vi.unstubAllEnvs());

const shipFrom = {
  name: "Warehouse",
  phone: "512-555-0000",
  address1: "100 Dock Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78702",
  country: "US",
};

async function setShipFrom(address: unknown = shipFrom) {
  await loadSettings(db);
  await db.settings.updateMany({ data: { shipFromAddress: address as Prisma.InputJsonValue } });
}

/**
 * Stores a fake provider's catalog as a sync would, with the listed service codes (and their
 * carriers) on and everything else off.
 */
async function catalog(provider: ProviderId, enabled: string[]) {
  for (const carrier of await createFakeShippingProvider(provider).listCarriers()) {
    const on = carrier.services.some((s) => enabled.includes(s.code));
    await db.shippingCarrier.create({
      data: {
        provider,
        externalId: carrier.externalId,
        code: carrier.externalId,
        name: carrier.name,
        enabled: on,
        services: {
          create: carrier.services.map((s) => ({
            code: s.code,
            name: s.name,
            domestic: s.domestic,
            international: s.international,
            enabled: enabled.includes(s.code),
            providerData: s.providerData as Prisma.InputJsonObject,
          })),
        },
      },
    });
  }
}

/** Both fakes, each recording the services every rate request named. */
function fakes() {
  const sent: Record<ProviderId, string[][]> = { SHIPSTATION: [], BRIDGE_SOURCE: [] };
  const make = (id: ProviderId) => {
    const provider = createFakeShippingProvider(id);
    const getRates = provider.getRates.bind(provider);
    provider.getRates = (request: RateRequest) => {
      sent[id].push(request.services.map((s) => s.code));
      return getRates(request);
    };
    return provider;
  };
  return { shipStation: make("SHIPSTATION"), bridge: make("BRIDGE_SOURCE"), sent };
}

/** A provider that returns exactly `rates` (or throws `error`) once `gate` resolves. */
function stub(
  id: ProviderId,
  rates: Partial<ProviderRate>[] | Error,
  gate: Promise<void> = Promise.resolve(),
): ShippingProvider & { calls: RateRequest[] } {
  const calls: RateRequest[] = [];
  const base = createFakeShippingProvider(id);
  return Object.assign(base, {
    calls,
    async getRates(request: RateRequest): Promise<ProviderRate[]> {
      calls.push(request);
      await gate;
      if (rates instanceof Error) throw rates;
      return rates.map((r) => ({
        carrierExternalId: "",
        serviceCode: "",
        serviceName: r.serviceCode ?? "",
        amountCents: 0,
        currency: "USD",
        guaranteed: false,
        trackable: true,
        ...r,
      }));
    },
  });
}

/** An order in QA with `packages`, each weighed and boxed, and its rate fetch requested. */
async function inQa(spec: OrderSpec = {}, packages = 1) {
  const built = await createOrder(db, {
    status: "QA",
    lines: [{ quantity: packages, pickStatus: "PICKED" }],
    packages: Array.from({ length: packages }, () => ({
      items: [{ line: 0, quantity: 1 }],
      weightOz: 20,
    })),
    ...spec,
  });
  await db.order.update({ where: { id: built.order.id }, data: { rateGeneration: 1 } });
  return { ...built, payload: { orderId: built.order.id, generation: 1 } };
}

const ratesOf = (packageId: string) =>
  db.shippingRate.findMany({
    where: { packageId },
    orderBy: [{ amountCents: "asc" }, { provider: "asc" }],
    include: { carrier: true, service: true },
  });
const pkgRow = (id: string) => db.package.findUniqueOrThrow({ where: { id } });
const jobs = (orderId: string) =>
  db.$queryRaw<{ data: { orderId: string; generation: number } }[]>`
    SELECT data FROM pgboss.job WHERE name = ${queues.ratesFetch} AND data->>'orderId' = ${orderId}`;

describe("fetchRates fan-out (SC 8)", () => {
  it("stores both providers' rates, tagged, and selects only the cheapest", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_ground_saver"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { shipStation, bridge } = fakes();
    const { packages, payload } = await inQa();

    const result = await fetchRates(db, [shipStation, bridge], payload);

    expect(result).toEqual({ status: "done" });
    const rates = await ratesOf(packages[0]?.id as string);
    expect(rates.map((r) => [r.provider, r.service.code, r.amountCents, r.selected])).toEqual([
      // 20 oz: base + per-oz × 20
      ["SHIPSTATION", "demo_ground_saver", 395 + 14 * 20, true],
      ["SHIPSTATION", "demo_ground", 450 + 12 * 20, false],
      ["BRIDGE_SOURCE", "GND", 430 + 13 * 20, false],
    ]);
    expect(rates.find((r) => r.provider === "BRIDGE_SOURCE")?.carrier.externalId).toBe("DEMOGND");
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "READY",
      rateErrors: [],
      ratesFetchedAt: expect.any(Date),
    });
  });

  it("sends only enabled services of enabled, still-listed carriers, matching domestic", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_express", "demo_express_intl"]);
    await catalog("BRIDGE_SOURCE", ["GND", "EXP"]);
    await db.shippingCarrier.updateMany({
      where: { externalId: "se-demo-express" },
      data: { missingSince: new Date() },
    });
    await db.shippingCarrier.updateMany({
      where: { externalId: "DEMOEXP" },
      data: { enabled: false },
    });
    const { shipStation, bridge, sent } = fakes();
    const { payload } = await inQa();

    await fetchRates(db, [shipStation, bridge], payload);

    expect(sent.SHIPSTATION).toEqual([["demo_ground"]]);
    expect(sent.BRIDGE_SOURCE).toEqual([["GND"]]);
  });

  it("sends only international services to an address outside the US", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_express_intl"]);
    const { shipStation, sent } = fakes();
    const mx = {
      name: "Luis",
      address1: "Av. Reforma 1",
      city: "CDMX",
      postalCode: "06600",
      country: "MX",
    };
    const { packages, payload } = await inQa();
    await db.order.update({
      where: { id: payload.orderId },
      data: { shippingAddress: mx, billingAddress: mx },
    });

    await fetchRates(db, [shipStation], payload);

    expect(sent.SHIPSTATION).toEqual([["demo_express_intl"]]);
    expect((await ratesOf(packages[0]?.id as string)).map((r) => r.serviceCode)).toEqual([
      "demo_express_intl",
    ]);
  });

  it("skips a provider with no usable services, naming it", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    await catalog("BRIDGE_SOURCE", []);
    const { shipStation, bridge, sent } = fakes();
    const { packages, payload } = await inQa();

    await fetchRates(db, [shipStation, bridge], payload);

    expect(sent.BRIDGE_SOURCE).toEqual([]);
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "READY",
      rateErrors: [{ provider: "BRIDGE_SOURCE", messageKey: "errors.carriers.noCarriers" }],
    });
  });

  it("drops rates for services that aren't enabled", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const provider = stub("SHIPSTATION", [
      { carrierExternalId: "se-demo-ground", serviceCode: "demo_ground", amountCents: 700 },
      { carrierExternalId: "se-demo-ground", serviceCode: "demo_ground_saver", amountCents: 100 },
      { carrierExternalId: "se-unknown", serviceCode: "x", amountCents: 50 },
    ]);
    const { packages, payload } = await inQa();

    await fetchRates(db, [provider], payload);

    const rates = await ratesOf(packages[0]?.id as string);
    expect(rates.map((r) => [r.serviceCode, r.selected])).toEqual([["demo_ground", true]]);
  });

  it("breaks price ties by fewer days, then provider order, then service name", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_ground_saver", "demo_express"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const ground = { carrierExternalId: "se-demo-ground", amountCents: 500 };
    const select = async (ss: Partial<ProviderRate>[], bs: Partial<ProviderRate>[]) => {
      const { packages, payload } = await inQa();
      await fetchRates(db, [stub("BRIDGE_SOURCE", bs), stub("SHIPSTATION", ss)], payload);
      return (await ratesOf(packages[0]?.id as string)).find((r) => r.selected)?.serviceName;
    };
    const gnd = { carrierExternalId: "DEMOGND", serviceCode: "GND", amountCents: 500 };

    expect(
      await select(
        [{ ...ground, serviceCode: "demo_ground", serviceName: "A", deliveryDays: 5 }],
        [{ ...gnd, serviceName: "B", deliveryDays: 3 }],
      ),
    ).toBe("B");
    // Same days: ShipStation comes first, whatever order the providers were passed in.
    expect(
      await select(
        [{ ...ground, serviceCode: "demo_ground", serviceName: "Z", deliveryDays: 3 }],
        [{ ...gnd, serviceName: "A", deliveryDays: 3 }],
      ),
    ).toBe("Z");
    expect(
      await select(
        [
          { ...ground, serviceCode: "demo_ground", serviceName: "Ground" },
          { ...ground, serviceCode: "demo_ground_saver", serviceName: "Saver" },
          {
            carrierExternalId: "se-demo-express",
            serviceCode: "demo_express",
            serviceName: "Zed",
            amountCents: 500,
          },
        ],
        [],
      ),
    ).toBe("Ground");
  });

  it("asks each provider once per package, and in parallel", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const slow = (id: ProviderId) => createFakeShippingProvider(id, { latencyMs: 300 });
    const { packages, payload } = await inQa({}, 3);

    const started = Date.now();
    await fetchRates(db, [slow("SHIPSTATION"), slow("BRIDGE_SOURCE")], payload);

    expect(Date.now() - started).toBeLessThan(1_500);
    for (const pkg of packages) expect(await ratesOf(pkg.id)).toHaveLength(2);
  });

  it("expires rates after RATE_TTL_HOURS unless the provider gives an expiry", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_ground_saver"]);
    const now = new Date("2026-10-27T12:00:00Z");
    const own = new Date("2026-10-27T18:00:00Z");
    const provider = stub("SHIPSTATION", [
      { carrierExternalId: "se-demo-ground", serviceCode: "demo_ground", amountCents: 1 },
      {
        carrierExternalId: "se-demo-ground",
        serviceCode: "demo_ground_saver",
        amountCents: 2,
        expiresAt: own,
      },
    ]);
    const { packages, payload } = await inQa();

    await fetchRates(db, [provider], payload, { now });

    const rates = await ratesOf(packages[0]?.id as string);
    expect(rates.map((r) => r.expiresAt)).toEqual([
      new Date(now.getTime() + RATE_TTL_HOURS * 3_600_000),
      own,
    ]);
    expect(rates.every((r) => r.fetchedAt.getTime() === now.getTime())).toBe(true);
  });

  it("sends the order, ship-from, ship-to, package and items", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const provider = stub("SHIPSTATION", []);
    const { order, payload } = await inQa({
      lines: [{ quantity: 1, pickStatus: "PICKED", sku: "SOAP-1", name: "Soap" }],
    });

    await fetchRates(db, [provider], payload);

    expect(provider.calls[0]).toMatchObject({
      orderNumber: order.number,
      shipFrom,
      shipTo: { name: "Test Customer", address1: "1 Main St", postalCode: "78701", country: "US" },
      residential: true,
      // The factory's box: 10 × 8 × 4 inner, no outer dimensions.
      package: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20 },
      items: [{ sku: "SOAP-1", name: "Soap", quantity: 1 }],
      services: [{ carrierExternalId: "se-demo-ground", code: "demo_ground", providerData: {} }],
    });
  });
});

describe("fetchRates ship-to (SC 6)", () => {
  it("stores the resolved ship-to and rates it", async () => {
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const provider = stub("BRIDGE_SOURCE", []);
    const { payload } = await inQa();
    await db.order.update({
      where: { id: payload.orderId },
      data: {
        shippingAddress: { name: "Ana", address1: "5 Elm St", city: "Austin", country: "US" },
        billingAddress: { postalCode: "78701", state: "TX" },
      },
    });

    await fetchRates(db, [provider], payload);

    const shipTo = {
      name: "Ana",
      address1: "5 Elm St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    };
    expect(provider.calls[0]?.shipTo).toEqual(shipTo);
    expect(await db.order.findUniqueOrThrow({ where: { id: payload.orderId } })).toMatchObject({
      shipTo,
      shipToOriginal: shipTo,
      shipToStatus: "UNCHECKED",
      shipToMessages: [],
    });
  });

  it("calls no provider when the address is incomplete", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const provider = stub("SHIPSTATION", []);
    const { packages, payload } = await inQa();
    await db.order.update({
      where: { id: payload.orderId },
      data: { shippingAddress: { name: "Ana" }, billingAddress: { city: "Austin" } },
    });

    expect(await fetchRates(db, [provider], payload)).toEqual({ status: "done" });

    expect(provider.calls).toEqual([]);
    expect(await db.order.findUniqueOrThrow({ where: { id: payload.orderId } })).toMatchObject({
      shipTo: null,
      shipToStatus: "INCOMPLETE",
      shipToMessages: ["address1", "postalCode", "country"],
    });
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "FAILED",
      rateErrors: [],
    });
  });

  it("fails every package, naming why, without a ship-from address", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    await setShipFrom(null);
    const provider = stub("SHIPSTATION", []);
    const { packages, payload } = await inQa();

    await fetchRates(db, [provider], payload);

    expect(provider.calls).toEqual([]);
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "FAILED",
      rateErrors: [{ provider: null, messageKey: "errors.carriers.noShipFrom" }],
    });
  });

  it("fails every package when no provider is enabled", async () => {
    const { packages, payload } = await inQa();

    await fetchRates(db, [], payload);

    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "FAILED",
      rateErrors: [{ provider: null, messageKey: "errors.carriers.noProviders" }],
    });
  });
});

describe("fetchRates failures (SC 9)", () => {
  it("keeps the other provider's rates when one times out, and doesn't retry", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { shipStation, bridge } = fakes();
    bridge.failNext("timeout");
    const { packages, payload } = await inQa();

    expect(await fetchRates(db, [shipStation, bridge], payload, { finalAttempt: false })).toEqual({
      status: "done",
    });

    expect((await ratesOf(packages[0]?.id as string)).map((r) => r.provider)).toEqual([
      "SHIPSTATION",
    ]);
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "READY",
      rateErrors: [{ provider: "BRIDGE_SOURCE", messageKey: "errors.shipping.timeout" }],
    });
  });

  it("times a provider out after timeoutMs", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const slow = createFakeShippingProvider("SHIPSTATION", { latencyMs: 500 });
    const { packages, payload } = await inQa();

    await fetchRates(db, [slow], payload, { timeoutMs: 20 });

    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "FAILED",
      rateErrors: [{ provider: "SHIPSTATION", messageKey: "errors.shipping.timeout" }],
    });
  });

  it("throws for a retry when every provider failed transiently, then fails on the last attempt", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { shipStation, bridge } = fakes();
    // The first failure goes to the address check, the second to the rates.
    shipStation.failNext(500, 2);
    bridge.failNext("network");
    const { packages, payload } = await inQa();

    await expect(
      fetchRates(db, [shipStation, bridge], payload, { finalAttempt: false }),
    ).rejects.toBeInstanceOf(RatesRetryError);
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "FETCHING" });

    shipStation.failNext(500);
    bridge.failNext("network");
    await fetchRates(db, [shipStation, bridge], payload, { finalAttempt: true });
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "FAILED",
      rateErrors: [
        { provider: "SHIPSTATION", messageKey: "errors.shipping.unavailable" },
        { provider: "BRIDGE_SOURCE", messageKey: "errors.shipping.unavailable" },
      ],
    });
  });

  it("doesn't retry permanent failures", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const { shipStation } = fakes();
    shipStation.failNext(401, 2);
    const { packages, payload } = await inQa();

    await fetchRates(db, [shipStation], payload, { finalAttempt: false });

    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({
      ratesStatus: "FAILED",
      rateErrors: [{ provider: "SHIPSTATION", messageKey: "errors.shipping.unauthorized" }],
    });
  });
});

describe("generation (SC 11)", () => {
  it("a job finishing after a refresh writes nothing", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = stub(
      "SHIPSTATION",
      [{ carrierExternalId: "se-demo-ground", serviceCode: "demo_ground", amountCents: 1 }],
      gate,
    );
    const { packages, payload } = await inQa();
    const qa = await createActor(db, ["QA"]);

    const slow = fetchRates(db, [provider], payload);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await refreshRates(db, qa, { orderId: payload.orderId });
    release();

    expect(await slow).toEqual({ status: "stale" });
    expect(await ratesOf(packages[0]?.id as string)).toEqual([]);
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "FETCHING" });
  });

  it("a job for an old generation exits before calling anyone", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const provider = stub("SHIPSTATION", []);
    const { payload } = await inQa();

    expect(await fetchRates(db, [provider], { ...payload, generation: 0 })).toEqual({
      status: "stale",
    });
    expect(provider.calls).toEqual([]);
  });

  it("a package change makes an in-flight job write nothing, and marks rates stale", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const packer = await createActor(db, ["PACKER"]);
    const { packages, payload } = await inQa();
    await fetchRates(db, [stub("SHIPSTATION", [])], payload);
    // Sent back to Packing, where the packer changes the weight while a fetch is in flight.
    await db.order.update({
      where: { id: payload.orderId },
      data: { status: "PACKING", claimedById: packer.userId, claimedAt: new Date() },
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = stub(
      "SHIPSTATION",
      [{ carrierExternalId: "se-demo-ground", serviceCode: "demo_ground", amountCents: 1 }],
      gate,
    );
    await db.package.update({
      where: { id: packages[0]?.id as string },
      data: { ratesStatus: "READY" },
    });
    const slow = fetchRates(db, [provider], payload);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await setWeight(db, packer, { packageId: packages[0]?.id as string, weightOz: 25 });
    release();

    expect(await slow).toEqual({ status: "stale" });
    expect(await ratesOf(packages[0]?.id as string)).toEqual([]);
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "STALE" });
  });
});

describe("Packing → QA hook (SC 12)", () => {
  async function packed() {
    const packer = await createActor(db, ["PACKER"]);
    const built = await createOrder(db, {
      status: "PACKING",
      version: 3,
      claimedById: packer.userId,
      lines: [{ quantity: 1, pickStatus: "PICKED" }],
      packages: [{ items: [{ line: 0, quantity: 1 }], weightOz: 16 }],
    });
    return { packer, ...built };
  }

  it("completing packing enqueues exactly one rates.fetch for the new generation", async () => {
    const { packer, order } = await packed();

    await completePack(db, packer, { orderId: order.id, expectedVersion: 3, after: "queue" });

    expect(await jobs(order.id)).toEqual([{ data: { orderId: order.id, generation: 1 } }]);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      rateGeneration: 1,
    });
  });

  it("a rolled-back completion enqueues none", async () => {
    const { packer, order } = await packed();

    await expect(
      db.$transaction(async (tx) => {
        await transition(tx, packer, {
          orderId: order.id,
          expectedVersion: 3,
          to: "QA",
          kind: "completePacking",
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await jobs(order.id)).toEqual([]);
  });
});

describe("refreshRates", () => {
  it("allowed for QA: bumps the generation, enqueues, marks packages fetching, audits", async () => {
    const qa = await createActor(db, ["QA"]);
    const { packages, payload } = await inQa();

    const shipping = await refreshRates(db, qa, { orderId: payload.orderId });

    expect(shipping.packages[0]).toMatchObject({
      id: packages[0]?.id as string,
      ratesStatus: "FETCHING",
    });
    expect(await jobs(payload.orderId)).toEqual([
      { data: { orderId: payload.orderId, generation: 2 } },
    ]);
    expect(
      await db.auditEvent.findFirst({
        where: { entityId: payload.orderId, action: "rates.refresh" },
      }),
    ).toMatchObject({ actorId: qa.userId });
  });

  it("forbidden for a Picker", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { payload } = await inQa();
    await expect(refreshRates(db, picker, { orderId: payload.orderId })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await jobs(payload.orderId)).toEqual([]);
  });

  it("refused outside QA", async () => {
    const qa = await createActor(db, ["QA"]);
    const { payload } = await inQa({ status: "PACKING" });
    await expect(refreshRates(db, qa, { orderId: payload.orderId })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.carriers.notInQa",
    });
  });

  it("refused while a package has a live label", async () => {
    const qa = await createActor(db, ["QA"]);
    const { payload } = await inQa({
      lines: [{ quantity: 1, pickStatus: "PICKED" }],
      packages: [{ items: [{ line: 0, quantity: 1 }], label: "ACTIVE" }],
    });
    await expect(refreshRates(db, qa, { orderId: payload.orderId })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.carriers.liveLabel",
    });
    expect(await jobs(payload.orderId)).toEqual([]);
  });
});

describe("disabled provider (SC 10)", () => {
  async function enable(id: ShippingProviderId, enabled: boolean) {
    await db.shippingProviderAccount.update({ where: { provider: id }, data: { enabled } });
  }

  it("is never asked, and its earlier rates stay until a refresh", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SHIPPING_PROVIDERS", undefined);
    vi.stubEnv("SHIPSTATION_API_KEY", undefined);
    const admin = await createActor(db, ["ADMIN"]);
    const qa = await createActor(db, ["QA"]);
    await setProviderCredentials(db, admin, {
      provider: "SHIPSTATION",
      credentials: { apiKey: "k" },
    });
    await setProviderCredentials(db, admin, {
      provider: "BRIDGE_SOURCE",
      credentials: { apiKey: "k", customerId: "C" },
    });
    await enable("SHIPSTATION", true);
    await enable("BRIDGE_SOURCE", true);
    await catalog("SHIPSTATION", ["demo_ground"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { shipStation, bridge, sent } = fakes();
    const adapters: AdapterFactories = {
      SHIPSTATION: () => shipStation,
      BRIDGE_SOURCE: () => bridge,
    };
    const { packages, payload } = await inQa();

    await runRatesFetchJob(db, payload, { adapters });
    expect((await ratesOf(packages[0]?.id as string)).map((r) => r.provider).sort()).toEqual([
      "BRIDGE_SOURCE",
      "SHIPSTATION",
    ]);

    await enable("BRIDGE_SOURCE", false);
    expect(await ratesOf(packages[0]?.id as string)).toHaveLength(2);

    await refreshRates(db, qa, { orderId: payload.orderId });
    await runRatesFetchJob(db, { ...payload, generation: 2 }, { adapters });
    expect(sent.BRIDGE_SOURCE).toHaveLength(1);
    expect((await ratesOf(packages[0]?.id as string)).map((r) => r.provider)).toEqual([
      "SHIPSTATION",
    ]);
  });
});

describe("getOrderShipping", () => {
  it("allowed for any role: ship-to and per package the rates, cheapest first", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_ground_saver"]);
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { shipStation, bridge } = fakes();
    bridge.failNext(500);
    const { packages, payload } = await inQa();
    const now = new Date();
    await fetchRates(db, [shipStation, bridge], payload, { now });
    // One rate already past its expiry.
    await db.shippingRate.updateMany({
      where: { serviceCode: "demo_ground" },
      data: { expiresAt: new Date(now.getTime() - 1_000) },
    });
    const picker = await createActor(db, ["PICKER"]);

    const shipping = await getOrderShipping(db, picker, { orderId: payload.orderId });

    expect(shipping).toMatchObject({
      orderId: payload.orderId,
      refreshable: true,
      shipTo: {
        status: "VERIFIED",
        address: { name: "Test Customer", city: "Austin" },
        original: { name: "Test Customer" },
        messages: [],
      },
      packages: [
        {
          id: packages[0]?.id as string,
          number: 1,
          ratesStatus: "READY",
          rateErrors: [{ provider: "BRIDGE_SOURCE", messageKey: "errors.shipping.unavailable" }],
          rates: [
            {
              provider: "SHIPSTATION",
              carrierName: "Demo Ground",
              serviceName: "Demo Ground Saver",
              amountCents: 395 + 14 * 20,
              currency: "USD",
              deliveryDays: 7,
              guaranteed: false,
              expired: false,
              selected: true,
            },
            { serviceName: "Demo Ground", expired: true, selected: false },
          ],
        },
      ],
    });
  });

  it("forbidden without order.read", async () => {
    const nobody = await createActor(db, []);
    const { payload } = await inQa();
    await expect(getOrderShipping(db, nobody, { orderId: payload.orderId })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("isn't refreshable outside QA", async () => {
    const qa = await createActor(db, ["QA"]);
    const { payload } = await inQa({ status: "READY" });
    expect(await getOrderShipping(db, qa, { orderId: payload.orderId })).toMatchObject({
      refreshable: false,
    });
  });
});

describe("packing marks changed rates stale", () => {
  it("sets STALE on a package whose rates were fetched, and leaves NONE alone", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { packages } = await createOrder(db, {
      status: "PACKING",
      claimedById: packer.userId,
      lines: [{ quantity: 2, pickStatus: "PICKED" }],
      packages: [
        { items: [{ line: 0, quantity: 1 }], rates: [{ selected: true }] },
        { items: [{ line: 0, quantity: 1 }] },
      ],
    });
    await db.package.update({
      where: { id: packages[0]?.id as string },
      data: { ratesStatus: "READY" },
    });

    await setWeight(db, packer, { packageId: packages[0]?.id as string, weightOz: 30 });
    await setWeight(db, packer, { packageId: packages[1]?.id as string, weightOz: 30 });

    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "STALE" });
    expect(await pkgRow(packages[1]?.id as string)).toMatchObject({ ratesStatus: "NONE" });
    expect(await ratesOf(packages[0]?.id as string)).toEqual([]);
  });
});

describe("address validation (SC 7)", () => {
  const original = {
    name: "Test Customer",
    address1: "1 Main St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  };
  const fixed = { ...original, address1: "1 MAIN ST", postalCode: "78701-1234" };
  const order = (orderId: string) => db.order.findUniqueOrThrow({ where: { id: orderId } });

  /** Rates one service, and answers the address check with `check` (or throws it). */
  function checking(check: AddressCheck | Error, gate?: Promise<void>) {
    const provider = stub(
      "SHIPSTATION",
      [{ carrierExternalId: "se-demo-ground", serviceCode: "demo_ground", amountCents: 500 }],
      gate,
    );
    const checked: unknown[] = [];
    provider.validateAddress = async (address) => {
      checked.push(address);
      if (check instanceof Error) throw check;
      return check;
    };
    return Object.assign(provider, { checked });
  }

  beforeEach(() => catalog("SHIPSTATION", ["demo_ground"]));

  it.each([
    ["verified", { status: "verified", address: fixed, messages: [] }, "VERIFIED", original],
    [
      "corrected",
      { status: "corrected", address: fixed, messages: ["Street normalised."] },
      "CORRECTED",
      fixed,
    ],
    ["warning", { status: "warning", messages: ["Apartment missing."] }, "WARNING", original],
    ["error", { status: "error", messages: ["Address not found."] }, "ERROR", original],
  ] as [string, AddressCheck, string, typeof original][])(
    "%s: stores the right ship-to and rates it",
    async (_, check, status, shipTo) => {
      const provider = checking(check);
      const { packages, payload } = await inQa();
      const now = new Date("2026-10-27T12:00:00Z");

      await fetchRates(db, [provider], payload, { now });

      expect(provider.checked).toEqual([original]);
      expect(provider.calls[0]?.shipTo).toEqual(shipTo);
      expect(await order(payload.orderId)).toMatchObject({
        shipTo,
        shipToOriginal: original,
        shipToStatus: status,
        shipToMessages: check.messages,
        shipToCheckedAt: now,
      });
      // An undeliverable address is a warning, never a block.
      expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "READY" });
    },
  );

  it("uses the provider's residential flag", async () => {
    const provider = checking({ status: "verified", residential: false, messages: [] });
    const { payload } = await inQa();

    await fetchRates(db, [provider], payload);

    expect(provider.calls[0]?.residential).toBe(false);
  });

  it("a failing check leaves the original unchecked and still rates", async () => {
    const provider = checking(new Error("boom"));
    const { packages, payload } = await inQa();

    await fetchRates(db, [provider], payload);

    expect(provider.calls[0]?.shipTo).toEqual(original);
    expect(await order(payload.orderId)).toMatchObject({
      shipTo: original,
      shipToOriginal: original,
      shipToStatus: "UNCHECKED",
      shipToCheckedAt: null,
    });
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "READY" });
  });

  it("a check slower than timeoutMs counts as failed", async () => {
    const provider = checking({ status: "verified", messages: [] });
    provider.validateAddress = () => new Promise(() => {});
    const { payload } = await inQa();

    await fetchRates(db, [provider], payload, { timeoutMs: 20 });

    expect(await order(payload.orderId)).toMatchObject({ shipToStatus: "UNCHECKED" });
  });

  it("asks the first enabled provider that can validate", async () => {
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { shipStation, bridge } = fakes();
    const { payload } = await inQa();
    await db.order.update({
      where: { id: payload.orderId },
      data: { shippingAddress: { ...original, address1: "1 Main Street" } },
    });

    await fetchRates(db, [bridge, shipStation], payload);

    expect(await order(payload.orderId)).toMatchObject({
      shipTo: { address1: "1 Main St" },
      shipToOriginal: { address1: "1 Main Street" },
      shipToStatus: "CORRECTED",
    });
  });

  it("with only the Bridge Source fake, stays unchecked and rates still come back", async () => {
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { bridge } = fakes();
    const { packages, payload } = await inQa();

    await fetchRates(db, [bridge], payload);

    expect(await order(payload.orderId)).toMatchObject({
      shipTo: original,
      shipToStatus: "UNCHECKED",
      shipToCheckedAt: null,
    });
    expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "READY" });
    expect(await ratesOf(packages[0]?.id as string)).toHaveLength(1);
  });

  describe("keepOriginalAddress", () => {
    async function corrected() {
      const provider = checking({ status: "corrected", address: fixed, messages: ["Fixed."] });
      const built = await inQa();
      await fetchRates(db, [provider], built.payload);
      return { ...built, provider };
    }

    it("allowed for QA: ships to the original, unchecked, and re-rates with it", async () => {
      const qa = await createActor(db, ["QA"]);
      const { packages, payload, provider } = await corrected();

      const shipping = await keepOriginalAddress(db, qa, { orderId: payload.orderId });

      expect(shipping.shipTo).toMatchObject({
        status: "UNCHECKED",
        address: original,
        original,
        messages: [],
        checkedAt: null,
      });
      expect(shipping.packages[0]).toMatchObject({ ratesStatus: "FETCHING", rates: [] });
      expect(await jobs(payload.orderId)).toEqual([
        { data: { orderId: payload.orderId, generation: 2 } },
      ]);
      expect(
        await db.auditEvent.findFirst({
          where: { entityId: payload.orderId, action: "shipTo.useOriginal" },
        }),
      ).toMatchObject({ actorId: qa.userId, after: { shipTo: original } });

      await fetchRates(db, [provider], { ...payload, generation: 2 });
      // Kept as the user chose: not checked again.
      expect(provider.checked).toHaveLength(1);
      expect(provider.calls.at(-1)?.shipTo).toEqual(original);
      expect(await order(payload.orderId)).toMatchObject({ shipTo: original });
      expect(await pkgRow(packages[0]?.id as string)).toMatchObject({ ratesStatus: "READY" });
    });

    it("forbidden for a Packer", async () => {
      const packer = await createActor(db, ["PACKER"]);
      const { payload } = await corrected();
      await expect(
        keepOriginalAddress(db, packer, { orderId: payload.orderId }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      expect(await order(payload.orderId)).toMatchObject({ shipTo: fixed });
    });

    it("refused outside QA, with a live label, or without an original", async () => {
      const qa = await createActor(db, ["QA"]);
      const packing = await inQa({ status: "PACKING" });
      await expect(
        keepOriginalAddress(db, qa, { orderId: packing.payload.orderId }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.carriers.notInQa" });

      const labelled = await inQa({
        lines: [{ quantity: 1, pickStatus: "PICKED" }],
        packages: [{ items: [{ line: 0, quantity: 1 }], label: "ACTIVE" }],
      });
      await expect(
        keepOriginalAddress(db, qa, { orderId: labelled.payload.orderId }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.carriers.liveLabel" });

      const unresolved = await inQa();
      await expect(
        keepOriginalAddress(db, qa, { orderId: unresolved.payload.orderId }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.carriers.noShipTo" });
    });
  });

  describe("recheckAddress", () => {
    it("allowed for QA: checks the address again and re-rates", async () => {
      const qa = await createActor(db, ["QA"]);
      const provider = checking(new Error("down"));
      const { payload } = await inQa();
      await fetchRates(db, [provider], payload);
      expect(await order(payload.orderId)).toMatchObject({ shipToStatus: "UNCHECKED" });

      const shipping = await recheckAddress(db, qa, { orderId: payload.orderId });

      expect(shipping.packages[0]).toMatchObject({ ratesStatus: "FETCHING", rates: [] });
      expect(await jobs(payload.orderId)).toEqual([
        { data: { orderId: payload.orderId, generation: 2 } },
      ]);
      expect(
        await db.auditEvent.findFirst({
          where: { entityId: payload.orderId, action: "shipTo.recheck" },
        }),
      ).toMatchObject({ actorId: qa.userId });

      const working = checking({ status: "corrected", address: fixed, messages: [] });
      await fetchRates(db, [working], { ...payload, generation: 2 });
      expect(working.calls[0]?.shipTo).toEqual(fixed);
      expect(await order(payload.orderId)).toMatchObject({
        shipTo: fixed,
        shipToStatus: "CORRECTED",
      });
    });

    it("forbidden for a Picker", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { payload } = await inQa();
      await expect(recheckAddress(db, picker, { orderId: payload.orderId })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
      expect(await jobs(payload.orderId)).toEqual([]);
    });

    it("refused outside QA", async () => {
      const qa = await createActor(db, ["QA"]);
      const { payload } = await inQa({ status: "READY" });
      await expect(recheckAddress(db, qa, { orderId: payload.orderId })).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.carriers.notInQa",
      });
    });
  });
});
