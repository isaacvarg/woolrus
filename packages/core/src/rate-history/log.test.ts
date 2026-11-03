import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, createRate } from "../../test/factories";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type {
  ProviderId,
  ProviderRate,
  RateRequest,
  ShippingProvider,
} from "../adapters/shipping/provider";
import addressVerified from "../adapters/shipping/shipstation/__fixtures__/address-verified.json" with {
  type: "json",
};
import rates from "../adapters/shipping/shipstation/__fixtures__/rates.json" with { type: "json" };
import { ShipStationAdapter } from "../adapters/shipping/shipstation/adapter";
import { fetchRates, refreshRates } from "../carriers/rates";
import { forgetShipTo, keepOriginalAddress, recheckAddress } from "../carriers/ship-to";
import { type OrderRateFetchTrigger, queues } from "../jobs";
import { completePack } from "../packing/complete";
import { loadSettings } from "../settings/service";

// SPEC-rate-history: every order rate fetch is kept, with its quotes, beside the working rates.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.ratesFetch}`;
  await loadSettings(db);
  await db.settings.updateMany({
    data: {
      shipFromAddress: {
        name: "Warehouse",
        phone: "512-555-0000",
        address1: "100 Dock Rd",
        city: "Austin",
        state: "TX",
        postalCode: "78702",
        country: "US",
      },
    },
  });
});

/** A fake provider's catalog as a sync would store it, with the listed service codes on. */
async function catalog(provider: ProviderId, enabled: string[]) {
  for (const carrier of await createFakeShippingProvider(provider).listCarriers()) {
    await db.shippingCarrier.create({
      data: {
        provider,
        externalId: carrier.externalId,
        code: carrier.externalId,
        name: carrier.name,
        enabled: carrier.services.some((s) => enabled.includes(s.code)),
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

const bothCatalogs = async () => {
  await catalog("SHIPSTATION", ["demo_ground", "demo_ground_saver"]);
  await catalog("BRIDGE_SOURCE", ["GND"]);
};
const bothFakes = () => [
  createFakeShippingProvider("SHIPSTATION"),
  createFakeShippingProvider("BRIDGE_SOURCE"),
];

/** A provider returning exactly `quotes` (or throwing `error`) once `gate` resolves. */
function stub(
  id: ProviderId,
  quotes: Partial<ProviderRate>[] | Error,
  gate: Promise<void> = Promise.resolve(),
): ShippingProvider & { calls: RateRequest[] } {
  const calls: RateRequest[] = [];
  return Object.assign(createFakeShippingProvider(id), {
    calls,
    async getRates(request: RateRequest): Promise<ProviderRate[]> {
      calls.push(request);
      await gate;
      if (quotes instanceof Error) throw quotes;
      return quotes.map((q) => ({
        carrierExternalId: "",
        serviceCode: "",
        serviceName: q.serviceCode ?? "",
        amountCents: 0,
        currency: "USD",
        guaranteed: false,
        trackable: true,
        ...q,
      }));
    },
  });
}

/** An order in QA with `packages`, weighed and boxed, at rate generation 1 (no trigger: a pre-deploy job). */
async function inQa(packages = 1) {
  const built = await createOrder(db, {
    status: "QA",
    lines: [{ quantity: packages, pickStatus: "PICKED" }],
    packages: Array.from({ length: packages }, () => ({
      items: [{ line: 0, quantity: 1 }],
      weightOz: 20,
    })),
  });
  await db.order.update({ where: { id: built.order.id }, data: { rateGeneration: 1 } });
  return { ...built, payload: { orderId: built.order.id, generation: 1 } };
}

/** The order's newest queued rates.fetch payload. */
async function lastJob(orderId: string) {
  const rows = await db.$queryRaw<
    { data: { orderId: string; generation: number; trigger?: OrderRateFetchTrigger } }[]
  >`SELECT data FROM pgboss.job WHERE name = ${queues.ratesFetch} AND data->>'orderId' = ${orderId}
    ORDER BY (data->>'generation')::int DESC LIMIT 1`;
  const job = rows[0];
  if (!job) throw new Error("no rates.fetch job");
  return job.data;
}

const fetchesOf = (orderId: string) =>
  db.rateFetch.findMany({
    where: { orderId },
    orderBy: { fetchedAt: "asc" },
    include: { quotes: { orderBy: [{ amountCents: "asc" }, { provider: "asc" }] } },
  });

describe("every order fetch is logged (SC 1)", () => {
  it("completing packing on a 2-package order logs a PACKING_COMPLETE fetch per package, one quote per rate", async () => {
    await bothCatalogs();
    const packer = await createActor(db, ["PACKER"]);
    const { order, packages } = await createOrder(db, {
      status: "PACKING",
      version: 3,
      claimedById: packer.userId,
      lines: [{ quantity: 2, pickStatus: "PICKED" }],
      packages: [
        { items: [{ line: 0, quantity: 1 }], weightOz: 16 },
        { items: [{ line: 0, quantity: 1 }], weightOz: 24 },
      ],
    });

    await completePack(db, packer, { orderId: order.id, expectedVersion: 3, after: "queue" });
    const job = await lastJob(order.id);
    expect(job.trigger).toBe("PACKING_COMPLETE");
    await fetchRates(db, bothFakes(), job);

    const fetches = await fetchesOf(order.id);
    expect(fetches.map((f) => [f.source, f.trigger, f.packageId]).sort()).toEqual(
      packages.map((p) => ["ORDER", "PACKING_COMPLETE", p.id]).sort(),
    );
    for (const pkg of packages) {
      const fetch = fetches.find((f) => f.packageId === pkg.id);
      const working = await db.shippingRate.findMany({
        where: { packageId: pkg.id },
        include: { quote: true },
      });
      expect(working).toHaveLength(3);
      expect(fetch?.quotes).toHaveLength(3);
      for (const rate of working) {
        expect(rate.quote).toMatchObject({
          fetchId: fetch?.id,
          provider: rate.provider,
          carrierId: rate.carrierId,
          serviceId: rate.serviceId,
          serviceCode: rate.serviceCode,
          amountCents: rate.amountCents,
          deliveryDays: rate.deliveryDays,
        });
      }
      expect(new Set(working.map((r) => r.quoteId)).size).toBe(3);
    }
  });

  it("records the parcel as quoted and whether it's international", async () => {
    await bothCatalogs();
    const { order, packages, payload } = await inQa();

    await fetchRates(db, bothFakes(), payload);

    const [fetch] = await fetchesOf(order.id);
    const pkg = await db.package.findUniqueOrThrow({
      where: { id: packages[0]?.id },
      include: { box: true },
    });
    expect(fetch).toMatchObject({
      boxId: pkg.boxId,
      international: false,
      residential: true,
      providerErrors: [],
    });
    expect(Number(fetch?.weightOz)).toBe(20);
    expect(Number(fetch?.lengthIn)).toBeGreaterThan(0);
  });
});

describe("nothing is lost (SC 2)", () => {
  it("Refresh rates replaces the working rates but keeps the first fetch; the new one is REFRESH", async () => {
    await bothCatalogs();
    const qa = await createActor(db, ["QA"]);
    const { order, packages, payload } = await inQa();
    await fetchRates(db, bothFakes(), payload);
    const [first] = await fetchesOf(order.id);

    await refreshRates(db, qa, { orderId: order.id });
    const job = await lastJob(order.id);
    expect(job.trigger).toBe("REFRESH");
    await fetchRates(db, bothFakes(), job);

    const fetches = await fetchesOf(order.id);
    expect(fetches.map((f) => f.trigger)).toEqual(["PACKING_COMPLETE", "REFRESH"]);
    expect(fetches[0]?.quotes.map((q) => q.id)).toEqual(first?.quotes.map((q) => q.id));
    const working = await db.shippingRate.findMany({ where: { packageId: packages[0]?.id } });
    expect(new Set(working.map((r) => r.quoteId))).toEqual(
      new Set(fetches[1]?.quotes.map((q) => q.id)),
    );
  });

  it("a job queued before deploy, without a trigger, is logged as PACKING_COMPLETE", async () => {
    await bothCatalogs();
    const { order, payload } = await inQa();

    await fetchRates(db, bothFakes(), payload);

    expect((await fetchesOf(order.id)).map((f) => f.trigger)).toEqual(["PACKING_COMPLETE"]);
  });

  it("the address actions and a store address change ask for an ADDRESS_CHANGE fetch", async () => {
    await bothCatalogs();
    const qa = await createActor(db, ["QA"]);
    const { order, payload } = await inQa();
    await fetchRates(db, bothFakes(), payload);

    const triggers: (OrderRateFetchTrigger | undefined)[] = [];
    await recheckAddress(db, qa, { orderId: order.id });
    const recheck = await lastJob(order.id);
    triggers.push(recheck.trigger);
    await fetchRates(db, bothFakes(), recheck);
    await keepOriginalAddress(db, qa, { orderId: order.id });
    triggers.push((await lastJob(order.id)).trigger);
    await db.$transaction((tx) => forgetShipTo(tx, { id: order.id, status: "QA" }));
    triggers.push((await lastJob(order.id)).trigger);

    expect(triggers).toEqual(["ADDRESS_CHANGE", "ADDRESS_CHANGE", "ADDRESS_CHANGE"]);
    expect((await fetchesOf(order.id)).map((f) => f.trigger)).toEqual([
      "PACKING_COMPLETE",
      "ADDRESS_CHANGE",
    ]);
  });

  it("a package deleted after its fetch keeps the fetch, with the package cleared", async () => {
    await bothCatalogs();
    const { order, packages, payload } = await inQa();
    await fetchRates(db, bothFakes(), payload);

    await db.package.delete({ where: { id: packages[0]?.id } });

    const fetches = await fetchesOf(order.id);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ packageId: null, orderId: order.id });
    expect(fetches[0]?.quotes).toHaveLength(3);
  });
});

describe("stale jobs write nothing (SC 3)", () => {
  it("a job whose generation was superseded while it ran logs no fetch", async () => {
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
    const { payload } = await inQa();
    const qa = await createActor(db, ["QA"]);

    const slow = fetchRates(db, [provider], payload);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await refreshRates(db, qa, { orderId: payload.orderId });
    release();

    expect(await slow).toEqual({ status: "stale" });
    expect(await db.rateFetch.count()).toBe(0);
  });
});

describe("failures are logged (SC 4)", () => {
  it("every provider failing on the last attempt logs one fetch with no quotes and both errors", async () => {
    await bothCatalogs();
    const shipStation = createFakeShippingProvider("SHIPSTATION");
    const bridge = createFakeShippingProvider("BRIDGE_SOURCE");
    // The first failure goes to the address check, the second to the rates.
    shipStation.failNext(500, 2);
    bridge.failNext("network");
    const { order, payload } = await inQa();

    await fetchRates(db, [shipStation, bridge], payload, { finalAttempt: true });

    const fetches = await fetchesOf(order.id);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.quotes).toEqual([]);
    expect(fetches[0]?.providerErrors).toEqual([
      { provider: "SHIPSTATION", messageKey: "errors.shipping.unavailable" },
      { provider: "BRIDGE_SOURCE", messageKey: "errors.shipping.unavailable" },
    ]);
  });

  it("logs nothing for an attempt that's retried", async () => {
    await bothCatalogs();
    const shipStation = createFakeShippingProvider("SHIPSTATION");
    const bridge = createFakeShippingProvider("BRIDGE_SOURCE");
    shipStation.failNext(500, 2);
    bridge.failNext("network");
    const { payload } = await inQa();

    await expect(
      fetchRates(db, [shipStation, bridge], payload, { finalAttempt: false }),
    ).rejects.toThrow();

    expect(await db.rateFetch.count()).toBe(0);
  });

  it("a partial failure logs the survivors' quotes and the failed provider's error", async () => {
    await bothCatalogs();
    const [shipStation, bridge] = bothFakes() as [
      ReturnType<typeof createFakeShippingProvider>,
      ReturnType<typeof createFakeShippingProvider>,
    ];
    bridge.failNext("timeout");
    const { order, payload } = await inQa();

    await fetchRates(db, [shipStation, bridge], payload);

    const [fetch] = await fetchesOf(order.id);
    expect(fetch?.quotes.map((q) => q.provider)).toEqual(["SHIPSTATION", "SHIPSTATION"]);
    expect(fetch?.providerErrors).toEqual([
      { provider: "BRIDGE_SOURCE", messageKey: "errors.shipping.timeout" },
    ]);
  });
});

describe("lane only (SC 5)", () => {
  it("keeps no name, street line or full postal code; the ZIP3 is its first three characters", async () => {
    await bothCatalogs();
    const { order, payload } = await inQa();
    const shipTo = {
      name: "Ada Lovelace",
      company: "Analytical Engines",
      address1: "12 Byron Court",
      address2: "Apt 9",
      city: "Austin",
      state: "TX",
      postalCode: "78745-1234",
      country: "US",
      phone: "512-555-0199",
      email: "ada@example.test",
    };
    await db.order.update({
      where: { id: order.id },
      data: { shippingAddress: shipTo, billingAddress: shipTo },
    });

    await fetchRates(db, bothFakes(), payload);

    const rows = await db.$queryRaw<{ row: unknown }[]>`
      SELECT row_to_json(f) AS row FROM rate_fetches f`;
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    for (const secret of [
      "Ada",
      "Lovelace",
      "Analytical",
      "Byron",
      "Apt 9",
      "78745",
      "1234",
      "555-0199",
      "ada@",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(await db.rateFetch.findFirstOrThrow()).toMatchObject({
      destCountry: "US",
      destState: "TX",
      destZip3: "787",
      residential: false,
    });
  });
});

describe("cheapest (SC 6)", () => {
  it("marks exactly one quote, the one carriers pre-selects", async () => {
    await bothCatalogs();
    const { order, packages, payload } = await inQa();

    await fetchRates(db, bothFakes(), payload);

    const [fetch] = await fetchesOf(order.id);
    expect(fetch?.quotes.filter((q) => q.cheapest)).toHaveLength(1);
    const selected = await db.shippingRate.findFirstOrThrow({
      where: { packageId: packages[0]?.id, selected: true },
    });
    expect(fetch?.quotes.find((q) => q.cheapest)?.id).toBe(selected.quoteId);
  });

  it("breaks a price tie by fewer delivery days", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_ground_saver"]);
    const provider = stub("SHIPSTATION", [
      {
        carrierExternalId: "se-demo-ground",
        serviceCode: "demo_ground_saver",
        amountCents: 500,
        deliveryDays: 5,
      },
      {
        carrierExternalId: "se-demo-ground",
        serviceCode: "demo_ground",
        amountCents: 500,
        deliveryDays: 3,
      },
    ]);
    const { order, payload } = await inQa();

    await fetchRates(db, [provider], payload);

    const [fetch] = await fetchesOf(order.id);
    expect(fetch?.quotes.filter((q) => q.cheapest).map((q) => q.serviceCode)).toEqual([
      "demo_ground",
    ]);
  });

  it("never marks a quote-only quote, even the cheapest", async () => {
    await bothCatalogs();
    const bridge = createFakeShippingProvider("BRIDGE_SOURCE", { quoteOnly: true });
    const getRates = bridge.getRates.bind(bridge);
    bridge.getRates = async (request) =>
      (await getRates(request)).map((r) => ({ ...r, amountCents: 100 }));
    const { order, payload } = await inQa();

    await fetchRates(db, [createFakeShippingProvider("SHIPSTATION"), bridge], payload);

    const [fetch] = await fetchesOf(order.id);
    const quoteOnly = fetch?.quotes.filter((q) => q.quoteOnly) ?? [];
    expect(quoteOnly.map((q) => [q.provider, q.amountCents, q.cheapest])).toEqual([
      ["BRIDGE_SOURCE", 100, false],
    ]);
    expect(fetch?.quotes.filter((q) => q.cheapest).map((q) => q.provider)).toEqual(["SHIPSTATION"]);
  });

  it("marks none in a fetch of only quote-only quotes", async () => {
    await catalog("BRIDGE_SOURCE", ["GND"]);
    const { order, payload } = await inQa();

    await fetchRates(
      db,
      [createFakeShippingProvider("BRIDGE_SOURCE", { quoteOnly: true })],
      payload,
    );

    const [fetch] = await fetchesOf(order.id);
    expect(fetch?.quotes).toHaveLength(1);
    expect(fetch?.quotes.some((q) => q.cheapest)).toBe(false);
  });
});

describe("fake flag (SC 7)", () => {
  it("the fakes carry the seam's fake marker; the ShipStation adapter doesn't", () => {
    expect(createFakeShippingProvider("SHIPSTATION").fake).toBe(true);
    expect(createFakeShippingProvider("BRIDGE_SOURCE").fake).toBe(true);
    const real: ShippingProvider = new ShipStationAdapter({ apiKey: "TEST_key" });
    expect(real.fake).toBeUndefined();
  });

  it("flags the fetch and quotes from the fakes", async () => {
    await bothCatalogs();
    const { order, payload } = await inQa();

    await fetchRates(db, bothFakes(), payload);

    const [fetch] = await fetchesOf(order.id);
    expect(fetch?.fake).toBe(true);
    expect(fetch?.quotes.every((q) => q.fake)).toBe(true);
  });

  it("doesn't flag quotes from the ShipStation adapter on fixtures", async () => {
    await db.shippingCarrier.create({
      data: {
        provider: "SHIPSTATION",
        externalId: "se-1000001",
        code: "ups",
        name: "UPS",
        enabled: true,
        services: {
          create: ["ups_ground", "ups_next_day_air"].map((code) => ({
            code,
            name: code,
            domestic: true,
            international: false,
            enabled: true,
          })),
        },
      },
    });
    const fixtureFetch: typeof globalThis.fetch = async (input) => {
      const body = String(input).includes("/addresses/") ? addressVerified : rates;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const shipStation = new ShipStationAdapter({ apiKey: "TEST_key" }, { fetch: fixtureFetch });
    const { order, payload } = await inQa();

    await fetchRates(db, [shipStation], payload);

    const [fetch] = await fetchesOf(order.id);
    expect(fetch?.fake).toBe(false);
    expect(fetch?.quotes.length).toBeGreaterThan(0);
    expect(fetch?.quotes.some((q) => q.fake)).toBe(false);
  });
});

describe("the migration's check constraints (SC 10)", () => {
  const lane = {
    destCountry: "US",
    residential: true,
    international: false,
    lengthIn: 10,
    widthIn: 8,
    heightIn: 4,
    weightOz: 16,
    fake: false,
  };

  it("rejects a LAB fetch with an order id, and an ORDER fetch with lab ids", async () => {
    const { order } = await createOrder(db, { status: "QA" });
    const labRunId = crypto.randomUUID();

    await expect(
      db.rateFetch.create({
        data: { ...lane, source: "LAB", trigger: "LAB_RUN", labRunId, orderId: order.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.rateFetch.create({
        data: { ...lane, source: "ORDER", trigger: "REFRESH", orderId: order.id, labRunId },
      }),
    ).rejects.toThrow();
    await expect(
      db.rateFetch.create({ data: { ...lane, source: "LAB", trigger: "LAB_RUN" } }),
    ).rejects.toThrow();
    await expect(
      db.rateFetch.create({ data: { ...lane, source: "LAB", trigger: "LAB_RUN", labRunId } }),
    ).resolves.toMatchObject({ labRunId });
  });

  it("rejects a selection note without reason OTHER, on rates and labels", async () => {
    const { packages } = await createOrder(db, { status: "QA", packages: [{}] });
    const packageId = packages[0]?.id as string;
    const label = (data: Partial<Prisma.ShippingLabelUncheckedCreateInput>) =>
      db.shippingLabel.create({
        data: {
          packageId,
          status: "VOIDED",
          provider: "SHIPSTATION",
          idempotencyKey: crypto.randomUUID(),
          carrierCode: "usps",
          serviceCode: "usps_ground_advantage",
          currency: "USD",
          ...data,
        },
      });

    await expect(
      createRate(db, packageId, { selectionReason: "FASTER_DELIVERY", selectionNote: "x" }),
    ).rejects.toThrow();
    await expect(createRate(db, packageId, { selectionNote: "x" })).rejects.toThrow();
    await expect(
      createRate(db, packageId, { selectionReason: "OTHER", selectionNote: "x" }),
    ).resolves.toMatchObject({ selectionNote: "x" });
    await expect(
      label({ selectionReason: "CUSTOMER_REQUESTED", selectionNote: "x" }),
    ).rejects.toThrow();
    await expect(label({ selectionReason: "OTHER", selectionNote: "x" })).resolves.toMatchObject({
      selectionNote: "x",
    });
  });
});
