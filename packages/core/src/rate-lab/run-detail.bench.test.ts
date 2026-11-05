import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { getLabRun } from "./run-detail";

/**
 * SPEC-rate-lab criterion 16: `run` loads a 250-combination × 10-quote run in under 500 ms at p95,
 * with an earlier suite run of every combination to compare against.
 */

const db: Db = testDb();
const ADDRESSES = 25;
const PARCELS = 10;
const QUOTES = 10;
const LOADS = 20;

const empty = { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] };

async function seedRun(
  createdAt: Date,
  addressIds: string[],
  parcelIds: string[],
  services: { id: string; carrierId: string; code: string; name: string }[],
) {
  const run = await db.rateLabRun.create({
    data: {
      kind: "SUITE",
      status: "SUCCEEDED",
      selection: empty,
      shipFrom: {},
      combinations: addressIds.length * parcelIds.length,
      createdAt,
    },
  });
  const fetches: Prisma.RateFetchCreateManyInput[] = [];
  const quotes: Prisma.RateQuoteCreateManyInput[] = [];
  for (const labAddressId of addressIds) {
    for (const labParcelId of parcelIds) {
      const id = crypto.randomUUID();
      fetches.push({
        id,
        source: "LAB",
        trigger: "LAB_RUN",
        labRunId: run.id,
        labAddressId,
        labParcelId,
        destCountry: "US",
        destState: "CO",
        residential: true,
        international: false,
        lengthIn: 10,
        widthIn: 8,
        heightIn: 4,
        weightOz: 20,
        fake: true,
        fetchedAt: createdAt,
      });
      services.forEach((service, i) => {
        quotes.push({
          fetchId: id,
          provider: "SHIPSTATION",
          carrierId: service.carrierId,
          serviceId: service.id,
          carrierCode: "bench",
          serviceCode: service.code,
          serviceName: service.name,
          amountCents: 800 + i * 50 + Math.floor(Math.random() * 200),
          currency: "USD",
          deliveryDays: 1 + (i % 5),
          guaranteed: false,
          quoteOnly: false,
          cheapest: i === 0,
          fake: true,
        });
      });
    }
  }
  await db.rateFetch.createMany({ data: fetches });
  await db.rateQuote.createMany({ data: quotes });
  return run;
}

let runId: string;

beforeAll(async () => {
  await resetDb(db);
  const carrier = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: "bench",
      code: "bench",
      name: "Bench",
      enabled: true,
      services: {
        create: Array.from({ length: QUOTES }, (_, i) => ({
          code: `svc_${i}`,
          name: `Service ${i}`,
          domestic: true,
          international: false,
          enabled: true,
        })),
      },
    },
    include: { services: true },
  });
  const value = {
    name: "C",
    address1: "1 Main St",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
  };
  const addressIds = Array.from({ length: ADDRESSES }, () => crypto.randomUUID());
  const parcelIds = Array.from({ length: PARCELS }, () => crypto.randomUUID());
  await db.rateLabAddress.createMany({
    data: addressIds.map((id, i) => ({
      id,
      title: `Address ${i}`,
      original: value,
      address: value,
      residential: true,
      checkStatus: "VERIFIED" as const,
    })),
  });
  await db.rateLabParcel.createMany({
    data: parcelIds.map((id, i) => ({
      id,
      title: `Parcel ${i}`,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 10 + i,
    })),
  });
  await seedRun(new Date(Date.UTC(2026, 9, 1)), addressIds, parcelIds, carrier.services);
  runId = (await seedRun(new Date(Date.UTC(2026, 9, 8)), addressIds, parcelIds, carrier.services))
    .id;
}, 120_000);
afterAll(() => db.$disconnect());

describe("run detail timing", () => {
  it(`loads ${ADDRESSES * PARCELS} combinations × ${QUOTES} quotes in under 500 ms at p95`, async () => {
    const lab = await createActor(db, ["RATE_LAB"]);
    const first = await getLabRun(db, lab, { id: runId });
    expect(first.combinations).toHaveLength(ADDRESSES * PARCELS);
    expect(first.combinations.every((c) => c.quotes.length === QUOTES && c.comparedWith)).toBe(
      true,
    );

    const times: number[] = [];
    for (let i = 0; i < LOADS; i++) {
      const started = performance.now();
      await getLabRun(db, lab, { id: runId });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(LOADS * 0.95) - 1] as number;
    expect(p95).toBeLessThan(500);
  }, 120_000);
});
