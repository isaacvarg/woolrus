import type { Db, ShippingRate } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { demoService, fakeProvider, verifiedQaOrder } from "../../test/qa-fixtures";
import { ShippingError } from "../adapters/shipping/errors";
import { createMemoryStorage } from "../adapters/storage/memory";
import { fetchRates } from "../carriers/rates";
import { completeQaWithLabels } from "../qa/complete";
import { purchaseLabels } from "../qa/purchase";
import { selectRate } from "../qa/rates";
import { logRateFetch } from "./log";

// SPEC-rate-history "Choice and purchase": a label remembers the logged quote it was bought from,
// and through it the fetch with the alternatives (criterion 9).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

/** Logs a fetch for the rate's package (the rate plus a pricier alternative) and links the rate to its quote. */
async function logged(rate: ShippingRate) {
  return db.$transaction(async (tx) => {
    const quote = {
      provider: rate.provider,
      carrierId: rate.carrierId,
      serviceId: rate.serviceId,
      carrierCode: rate.carrierCode,
      carrierExternalId: "se-demo-ground",
      serviceCode: rate.serviceCode,
      serviceName: rate.serviceName,
      amountCents: rate.amountCents,
      currency: rate.currency,
      guaranteed: false,
      trackable: true,
      quoteOnly: false,
    };
    const { fetchId, quoteIds } = await logRateFetch(tx, {
      source: "ORDER",
      trigger: "PACKING_COMPLETE",
      packageId: rate.packageId,
      shipTo: {
        name: "Test Customer",
        address1: "1 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      residential: true,
      international: false,
      parcel: { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 16 },
      providerErrors: [],
      rates: [quote, { ...quote, amountCents: rate.amountCents + 300, deliveryDays: 1 }],
      fakeProviders: new Set(["SHIPSTATION"]),
    });
    await tx.shippingRate.update({ where: { id: rate.id }, data: { quoteId: quoteIds[0] } });
    return { fetchId, quoteId: quoteIds[0] as string };
  });
}

async function requested({ log = true } = {}) {
  const built = await verifiedQaOrder(db, 1);
  const rate = built.rates[0] as ShippingRate;
  const quote = log ? await logged(rate) : null;
  await completeQaWithLabels(db, built.qa, {
    orderId: built.order.id,
    expectedVersion: built.order.version,
  });
  const provider = fakeProvider();
  const run = () =>
    purchaseLabels(
      db,
      { providers: [provider], storage: createMemoryStorage() },
      { orderId: built.order.id, requestedById: built.qa.userId },
    );
  return { ...built, quote, provider, run };
}

const onlyLabel = () => db.shippingLabel.findFirstOrThrow();

describe("a label remembers its quote (SC 9)", () => {
  it("a bought label references the selected rate's quote, and through it the fetch's alternatives", async () => {
    const { run, quote } = await requested();

    await run();

    const label = await db.shippingLabel.findFirstOrThrow({
      include: { rateQuote: { include: { fetch: { include: { quotes: true } } } } },
    });
    expect(label.status).toBe("ACTIVE");
    expect(label.rateQuoteId).toBe(quote?.quoteId);
    expect(label.rateQuote?.fetch.id).toBe(quote?.fetchId);
    expect(label.rateQuote?.fetch.quotes.map((q) => q.amountCents).sort()).toEqual([450, 750]);
  });

  it("links the quote from the moment the purchase is requested", async () => {
    const { quote } = await requested();

    expect(await onlyLabel()).toMatchObject({ status: "PURCHASING", rateQuoteId: quote?.quoteId });
  });

  it("a refused purchase keeps the quote it was attempted from", async () => {
    const { run, provider, quote } = await requested();
    vi.spyOn(provider, "purchaseLabel").mockRejectedValue(
      new ShippingError("notOffered", "purchaseLabel 422"),
    );

    await run();

    expect(await onlyLabel()).toMatchObject({
      status: "PURCHASE_FAILED",
      rateQuoteId: quote?.quoteId,
    });
  });

  it("a purchase reconciled after a lost response keeps its quote", async () => {
    const { run, provider, quote } = await requested();
    const real = provider.purchaseLabel.bind(provider);
    vi.spyOn(provider, "purchaseLabel").mockImplementationOnce(async (input) => {
      await real(input);
      throw new ShippingError("timeout", "purchaseLabel timeout");
    });
    await expect(run()).rejects.toThrow();

    await run();

    expect(await onlyLabel()).toMatchObject({ status: "ACTIVE", rateQuoteId: quote?.quoteId });
  });

  it("a rate older than the log buys a label with no quote, as before", async () => {
    const { run } = await requested({ log: false });

    await run();

    expect(await onlyLabel()).toMatchObject({ status: "ACTIVE", rateQuoteId: null });
  });
});

describe("the whole chain", () => {
  it("fetch, pick the pricier rate with a reason, buy: the label points at that quote, not the cheapest", async () => {
    const built = await verifiedQaOrder(db, 1);
    const pkg = built.packages[0];
    if (!pkg) throw new Error("package");
    // A real fetch instead of the fixture's rate: Demo Ground and the cheaper Demo Ground Saver.
    const { carrier } = await demoService(db);
    await db.carrierService.create({
      data: {
        carrierId: carrier.id,
        code: "demo_ground_saver",
        name: "Demo Ground Saver",
        domestic: true,
        international: false,
        enabled: true,
      },
    });
    await db.shippingRate.deleteMany({ where: { packageId: pkg.id } });
    await db.order.update({ where: { id: built.order.id }, data: { rateGeneration: 1 } });
    const provider = fakeProvider();
    await fetchRates(db, [provider], { orderId: built.order.id, generation: 1 });
    const pricier = await db.shippingRate.findFirstOrThrow({
      where: { packageId: pkg.id, serviceCode: "demo_ground" },
    });

    await selectRate(db, built.qa, {
      packageId: pkg.id,
      rateId: pricier.id,
      reason: "CARRIER_RELIABILITY",
    });
    await completeQaWithLabels(db, built.qa, {
      orderId: built.order.id,
      expectedVersion: built.order.version,
    });
    await purchaseLabels(
      db,
      { providers: [provider], storage: createMemoryStorage() },
      { orderId: built.order.id, requestedById: built.qa.userId },
    );

    const label = await db.shippingLabel.findFirstOrThrow({
      include: { rateQuote: { include: { fetch: { include: { quotes: true } } } } },
    });
    expect(label).toMatchObject({
      status: "ACTIVE",
      rateQuoteId: pricier.quoteId,
      selectionReason: "CARRIER_RELIABILITY",
    });
    const quotes = label.rateQuote?.fetch.quotes ?? [];
    expect(quotes.map((q) => q.serviceCode).sort()).toEqual(["demo_ground", "demo_ground_saver"]);
    const cheapest = quotes.filter((q) => q.cheapest);
    expect(cheapest.map((q) => q.serviceCode)).toEqual(["demo_ground_saver"]);
    expect(cheapest[0]?.id).not.toBe(label.rateQuoteId);
  });
});
