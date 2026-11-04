import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { UserActor } from "../permissions";
import { realOrders } from "./real-orders";

/**
 * SPEC-rate-lab criterion 16: Real orders over 10,000 packages loads in under 1 s. 2,000 orders of
 * 5 packages, each bought from a fetch of 3 quotes across 3 services and 10 states.
 */

const db: Db = testDb();
const ORDERS = 2_000;
const PER_ORDER = 5;
const RUNS = 5;
const now = new Date("2026-11-03T12:00:00Z");
let admin: UserActor;

const address = {
  name: "Bench",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};
const states = ["TX", "CA", "NY", "FL", "WA", "IL", "OH", "GA", "MT", "CO"];

beforeAll(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
  const carrier = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: "se-bench",
      code: "usps",
      name: "USPS",
      enabled: true,
    },
  });
  const services = await Promise.all(
    ["ga", "priority", "express"].map((code) =>
      db.carrierService.create({
        data: {
          carrierId: carrier.id,
          code,
          name: code,
          domestic: true,
          international: false,
          enabled: true,
        },
      }),
    ),
  );
  const box = await db.box.create({
    data: { name: "Bench box", lengthIn: 10, widthIn: 8, heightIn: 4 },
  });

  const orders = Array.from({ length: ORDERS }, (_, i) => ({
    id: crypto.randomUUID(),
    wooOrderId: 900_000 + i,
    number: `B${i}`,
    wooStatus: "processing",
    currency: "USD",
    customerName: "Bench",
    customerEmail: "bench@example.test",
    shippingAddress: address,
    billingAddress: address,
    totalCents: 2500,
    shippingChargedCents: 900 + (i % 7) * 100,
    shippingMethod: "Flat rate",
    orderedAt: now,
    wooModifiedAt: now,
    syncedAt: now,
    rawPayload: {},
    status: "COMPLETED" as const,
    statusChangedAt: now,
  }));
  await db.order.createMany({ data: orders });

  const packages = [];
  const fetches = [];
  const quotes = [];
  const labels = [];
  for (const [o, order] of orders.entries()) {
    for (let n = 1; n <= PER_ORDER; n += 1) {
      const i = o * PER_ORDER + n;
      const packageId = crypto.randomUUID();
      const fetchId = crypto.randomUUID();
      const at = new Date(now.getTime() - (i % 29) * 86_400_000 - 60_000);
      packages.push({ id: packageId, orderId: order.id, number: n, boxId: box.id, weightOz: 16 });
      fetches.push({
        id: fetchId,
        source: "ORDER" as const,
        trigger: "PACKING_COMPLETE" as const,
        orderId: order.id,
        packageId,
        destCountry: "US",
        destState: states[i % states.length] as string,
        residential: true,
        international: false,
        boxId: box.id,
        lengthIn: 10,
        widthIn: 8,
        heightIn: 4,
        weightOz: 16,
        fake: false,
        fetchedAt: at,
      });
      const ids = services.map(() => crypto.randomUUID());
      for (const [s, service] of services.entries()) {
        quotes.push({
          id: ids[s] as string,
          fetchId,
          provider: "SHIPSTATION" as const,
          carrierId: carrier.id,
          serviceId: service.id,
          carrierCode: "usps",
          serviceCode: service.code,
          serviceName: service.name,
          amountCents: 500 + s * 300 + (i % 50),
          currency: "USD",
          deliveryDays: 5 - s,
          guaranteed: false,
          quoteOnly: false,
          cheapest: s === 0,
          fake: false,
        });
      }
      const pick = i % 3;
      labels.push({
        packageId,
        status: "ACTIVE" as const,
        provider: "SHIPSTATION" as const,
        idempotencyKey: `bench-${i}`,
        carrierCode: "usps",
        serviceCode: services[pick]?.code as string,
        carrierId: carrier.id,
        serviceId: services[pick]?.id as string,
        costCents: 500 + pick * 300 + (i % 50),
        currency: "USD",
        purchasedAt: at,
        rateQuoteId: ids[pick] as string,
        selectionReason: pick === 0 ? null : ("FASTER_DELIVERY" as const),
      });
    }
  }
  await db.package.createMany({ data: packages });
  await db.rateFetch.createMany({ data: fetches });
  await db.rateQuote.createMany({ data: quotes });
  await db.shippingLabel.createMany({ data: labels });
  await db.$executeRawUnsafe("ANALYZE");
}, 120_000);
afterAll(() => db.$disconnect());

describe("Real orders timing", () => {
  it("loads 10,000 packages in under 1 s", async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      const result = await realOrders(db, admin, {}, { now });
      times.push(performance.now() - start);
      expect(result.choice.packages).toBe(ORDERS * PER_ORDER);
    }
    expect(Math.max(...times.slice(1))).toBeLessThan(1_000);
  }, 60_000);
});
