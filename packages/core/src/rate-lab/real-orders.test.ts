import type { Db, LabelStatus, RateSelectionReason } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { medianCents, realOrders } from "./real-orders";

// SPEC-rate-lab "Real orders" (criteria 13, 15): what real packages paid, over the quote log.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const now = new Date("2026-11-03T12:00:00Z");
let key = 0;

async function carrier(name: string, label: string | null, services: string[]) {
  const row = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: `se-${name}`,
      code: name.toLowerCase(),
      name,
      label,
      enabled: true,
    },
  });
  const created = await Promise.all(
    services.map((code) =>
      db.carrierService.create({
        data: {
          carrierId: row.id,
          code,
          name: code.toUpperCase(),
          domestic: true,
          international: false,
          enabled: true,
        },
      }),
    ),
  );
  return { carrier: row, services: created };
}

type Service = { id: string; carrierId: string; code: string; name: string };

type Spec = {
  /** The first quote is the fetch's cheapest; `buy` is the index of the one bought. */
  quotes: { service: Service; amountCents: number }[];
  buy: number;
  costCents?: number | null;
  reason?: RateSelectionReason;
  purchasedAt: string;
  state?: string;
  country?: string;
  status?: LabelStatus;
  fake?: boolean;
  linked?: boolean;
};

/** One order per entry of `packages`, its packages bought as each spec says. */
async function order(chargedCents: number, packages: Spec[]) {
  const built = await createOrder(db, { packages: packages.map(() => ({})) });
  await db.order.update({
    where: { id: built.order.id },
    data: { shippingChargedCents: chargedCents },
  });
  for (const [i, spec] of packages.entries()) {
    const pkg = built.packages[i];
    if (!pkg) throw new Error("missing package");
    const fetch = await db.rateFetch.create({
      data: {
        source: "ORDER",
        trigger: "PACKING_COMPLETE",
        orderId: built.order.id,
        packageId: pkg.id,
        destCountry: spec.country ?? "US",
        destState: spec.state ?? "TX",
        residential: true,
        international: false,
        boxId: pkg.boxId,
        lengthIn: 10,
        widthIn: 8,
        heightIn: 4,
        weightOz: 16,
        fake: spec.fake ?? false,
        fetchedAt: new Date(spec.purchasedAt),
      },
    });
    const quotes = [];
    for (const [q, quote] of spec.quotes.entries()) {
      quotes.push(
        await db.rateQuote.create({
          data: {
            fetchId: fetch.id,
            provider: "SHIPSTATION",
            carrierId: quote.service.carrierId,
            serviceId: quote.service.id,
            carrierCode: "c",
            serviceCode: quote.service.code,
            serviceName: quote.service.name,
            amountCents: quote.amountCents,
            currency: "USD",
            deliveryDays: 3 - q,
            guaranteed: false,
            quoteOnly: false,
            cheapest: q === 0,
            fake: spec.fake ?? false,
          },
        }),
      );
    }
    const bought = quotes[spec.buy];
    if (!bought) throw new Error("missing quote");
    await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: spec.status ?? "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: `label-${++key}`,
        carrierCode: "c",
        serviceCode: bought.serviceCode,
        carrierId: bought.carrierId,
        serviceId: bought.serviceId,
        costCents: spec.costCents === undefined ? bought.amountCents : spec.costCents,
        quotedAmountCents: bought.amountCents,
        currency: "USD",
        purchasedAt: new Date(spec.purchasedAt),
        rateQuoteId: spec.linked === false ? null : bought.id,
        selectionReason: spec.reason ?? null,
      },
    });
  }
  return { ...built, boxIds: built.packages.map((p) => p.boxId) };
}

async function seed() {
  const ups = await carrier("UPS", "UPS main", ["ups_ground"]);
  const usps = await carrier("USPS", null, ["usps_ga", "usps_priority"]);
  const upsGround = ups.services[0] as Service;
  const ga = usps.services[0] as Service;
  const priority = usps.services[1] as Service;

  // Order A (charged 10.00): 5.10 on the cheapest, then 9.00 for Priority over 6.00 (faster).
  const a = await order(1000, [
    {
      quotes: [
        { service: ga, amountCents: 500 },
        { service: upsGround, amountCents: 800 },
      ],
      buy: 0,
      costCents: 510,
      purchasedAt: "2026-10-28T10:00:00Z",
    },
    {
      quotes: [
        { service: ga, amountCents: 600 },
        { service: priority, amountCents: 900 },
      ],
      buy: 1,
      costCents: null,
      reason: "FASTER_DELIVERY",
      purchasedAt: "2026-10-29T10:00:00Z",
    },
  ]);
  // Order B (charged 12.00), California: UPS at 10.00 over 7.00, no reason.
  const b = await order(1200, [
    {
      quotes: [
        { service: ga, amountCents: 700 },
        { service: upsGround, amountCents: 1000 },
      ],
      buy: 1,
      state: "CA",
      purchasedAt: "2026-11-02T10:00:00Z",
    },
  ]);
  // Order C (charged 4.00): UPS at 4.50 over 4.00 (faster).
  const c = await order(400, [
    {
      quotes: [
        { service: ga, amountCents: 400 },
        { service: upsGround, amountCents: 450 },
      ],
      buy: 1,
      reason: "FASTER_DELIVERY",
      purchasedAt: "2026-11-02T15:00:00Z",
    },
  ]);
  const twoQuotes = [
    { service: ga, amountCents: 300 },
    { service: upsGround, amountCents: 2000 },
  ];
  // Left out: voided, fake, too old, not linked to a quote.
  await order(0, [
    { quotes: twoQuotes, buy: 1, status: "VOIDED", purchasedAt: "2026-11-01T10:00:00Z" },
  ]);
  await order(0, [{ quotes: twoQuotes, buy: 0, fake: true, purchasedAt: "2026-11-01T10:00:00Z" }]);
  await order(0, [{ quotes: twoQuotes, buy: 0, purchasedAt: "2026-09-01T10:00:00Z" }]);
  await order(0, [
    { quotes: twoQuotes, buy: 0, linked: false, purchasedAt: "2026-11-01T10:00:00Z" },
  ]);

  const admin = await createActor(db, ["ADMIN"]);
  return { admin, a, b, c, ups, usps };
}

describe("realOrders", () => {
  it("adds up the last 30 days of active, real, linked labels exactly", async () => {
    const { admin, a, b, c, ups, usps } = await seed();
    const upsId = ups.carrier.id;
    const uspsId = usps.carrier.id;
    const [upsGround] = ups.services;
    const [ga, priority] = usps.services;

    const result = await realOrders(db, admin, {}, { now });

    expect(result.from).toEqual(new Date("2026-10-04T12:00:00Z"));
    expect(result.to).toEqual(now);
    expect(result.choice).toEqual({
      packages: 4,
      onCheapest: 1,
      notCheapest: 3,
      overspendCents: 650,
      byReason: [
        { reason: "FASTER_DELIVERY", packages: 2, overspendCents: 350 },
        { reason: null, packages: 1, overspendCents: 300 },
      ],
    });
    expect(result.byCarrier).toEqual([
      { carrierId: upsId, name: "UPS main", packages: 2, spendCents: 1450 },
      { carrierId: uspsId, name: "USPS", packages: 2, spendCents: 1410 },
    ]);
    expect(result.byService).toEqual([
      {
        serviceId: upsGround?.id,
        carrierName: "UPS main",
        name: "UPS_GROUND",
        packages: 2,
        spendCents: 1450,
      },
      {
        serviceId: priority?.id,
        carrierName: "USPS",
        name: "USPS_PRIORITY",
        packages: 1,
        spendCents: 900,
      },
      { serviceId: ga?.id, carrierName: "USPS", name: "USPS_GA", packages: 1, spendCents: 510 },
    ]);
    expect(result.laneCost).toEqual([
      {
        country: "US",
        state: "CA",
        week: "2026-11-02",
        packages: 1,
        medianCents: 1000,
        meanCents: 1000,
      },
      {
        country: "US",
        state: "TX",
        week: "2026-10-26",
        packages: 2,
        medianCents: 705,
        meanCents: 705,
      },
      {
        country: "US",
        state: "TX",
        week: "2026-11-02",
        packages: 1,
        medianCents: 450,
        meanCents: 450,
      },
    ]);
    expect(result.costVsCharged).toEqual({
      orders: 3,
      costCents: 2860,
      chargedCents: 2600,
      overCount: 2,
      over: [
        { orderId: a.order.id, number: a.order.number, costCents: 1410, chargedCents: 1000 },
        { orderId: c.order.id, number: c.order.number, costCents: 450, chargedCents: 400 },
      ],
    });

    expect(result.alternatives.total).toBe(4);
    expect(result.alternatives.packages.map((p) => p.orderNumber)).toEqual([
      c.order.number,
      b.order.number,
      a.order.number,
      a.order.number,
    ]);
    expect(result.alternatives.packages[0]).toMatchObject({
      packageNumber: 1,
      country: "US",
      state: "TX",
      reason: "FASTER_DELIVERY",
      quotes: [
        {
          carrierName: "USPS",
          serviceName: "USPS_GA",
          amountCents: 400,
          cheapest: true,
          bought: false,
        },
        {
          carrierName: "UPS main",
          serviceName: "UPS_GROUND",
          amountCents: 450,
          cheapest: false,
          bought: true,
        },
      ],
    });

    expect(result.options.carriers.map((o) => o.name)).toEqual(["UPS main", "USPS"]);
    expect(result.options.countries).toEqual(["US"]);
    expect(result.options.states).toEqual([
      { country: "US", state: "CA" },
      { country: "US", state: "TX" },
    ]);
    expect(result.options.boxes).toHaveLength(4);
  });

  it("shows fake data only when asked", async () => {
    const { admin } = await seed();
    const result = await realOrders(db, admin, { includeFake: true }, { now });
    expect(result.choice).toMatchObject({ packages: 5, onCheapest: 2, overspendCents: 650 });
  });

  it("reads an explicit range of whole days", async () => {
    const { admin } = await seed();
    const result = await realOrders(db, admin, { from: "2026-09-01", to: "2026-10-28" }, { now });
    expect(result.from).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(result.to).toEqual(new Date("2026-10-29T00:00:00Z"));
    expect(result.choice).toMatchObject({ packages: 2, onCheapest: 2 });
  });

  it("filters by carrier, service, lane and box, keeping the options of the whole range", async () => {
    const { admin, a, usps } = await seed();
    const [, priority] = usps.services;
    const byCarrier = await realOrders(db, admin, { carrierId: usps.carrier.id }, { now });
    expect(byCarrier.choice).toMatchObject({ packages: 2, overspendCents: 300 });
    expect(byCarrier.options.carriers).toHaveLength(2);

    const byService = await realOrders(db, admin, { serviceId: priority?.id }, { now });
    expect(byService.choice.packages).toBe(1);

    const byState = await realOrders(db, admin, { country: "us", state: "ca" }, { now });
    expect(byState.choice).toMatchObject({ packages: 1, notCheapest: 1, overspendCents: 300 });

    // The filter picks the order; its cost is still both of its labels.
    const byBox = await realOrders(db, admin, { boxId: a.boxIds[1] ?? undefined }, { now });
    expect(byBox.costVsCharged).toMatchObject({ orders: 1, costCents: 1410, chargedCents: 1000 });
  });

  it("costs an order in the range with all its active labels, wherever they fall", async () => {
    const { services } = await carrier("USPS", null, ["usps_ga"]);
    const ga = services[0] as Service;
    const quotes = [{ service: ga, amountCents: 300 }];
    const from = "2026-10-04T12:00:00.000Z";
    const justBefore = "2026-10-04T11:59:59.999Z";
    const edge = await order(2000, [
      { quotes, buy: 0, costCents: 300, purchasedAt: from },
      { quotes, buy: 0, costCents: 700, purchasedAt: justBefore },
      { quotes, buy: 0, costCents: 900, linked: false, purchasedAt: "2026-10-30T10:00:00Z" },
      { quotes, buy: 0, costCents: 5000, status: "VOIDED", purchasedAt: from },
    ]);
    await order(100, [{ quotes, buy: 0, costCents: 300, purchasedAt: justBefore }]);
    const admin = await createActor(db, ["ADMIN"]);

    const result = await realOrders(db, admin, {}, { now });
    expect(result.from).toEqual(new Date(from));
    expect(result.choice.packages).toBe(1);
    expect(result.costVsCharged).toEqual({
      orders: 1,
      costCents: 1900,
      chargedCents: 2000,
      overCount: 0,
      over: [],
    });
    expect(result.alternatives.packages.map((p) => p.orderId)).toEqual([edge.order.id]);
  });

  it("leaves an order's labels bought on fake quotes out of its cost, unless fake data is asked for", async () => {
    const { services } = await carrier("USPS", null, ["usps_ga"]);
    const quotes = [{ service: services[0] as Service, amountCents: 300 }];
    const purchasedAt = "2026-11-01T10:00:00Z";
    await order(2000, [
      { quotes, buy: 0, costCents: 300, purchasedAt },
      { quotes, buy: 0, costCents: 700, fake: true, purchasedAt },
    ]);
    const admin = await createActor(db, ["ADMIN"]);

    const real = await realOrders(db, admin, {}, { now });
    expect(real.costVsCharged).toMatchObject({ orders: 1, costCents: 300, chargedCents: 2000 });
    const withFake = await realOrders(db, admin, { includeFake: true }, { now });
    expect(withFake.costVsCharged).toMatchObject({ orders: 1, costCents: 1000 });
  });

  it("caps the alternatives table, newest first", async () => {
    const { admin, c } = await seed();
    const result = await realOrders(db, admin, { alternativesLimit: 1 }, { now });
    expect(result.alternatives.total).toBe(4);
    expect(result.alternatives.packages.map((p) => p.orderId)).toEqual([c.order.id]);
  });

  it("is for report.read: an admin reads it, a Rate Lab user without it is refused", async () => {
    const rateLab = await createActor(db, ["RATE_LAB"]);
    await expect(realOrders(db, rateLab, {}, { now })).rejects.toMatchObject({ kind: "FORBIDDEN" });
    const admin = await createActor(db, ["ADMIN"]);
    await expect(realOrders(db, admin, {}, { now })).resolves.toMatchObject({
      choice: { packages: 0, byReason: [] },
    });
  });
});

describe("medianCents", () => {
  it("takes the middle value, or the rounded mean of the two middle ones", () => {
    expect(medianCents([600, 100, 200])).toBe(200);
    expect(medianCents([100, 200, 301, 400])).toBe(251);
  });
});
