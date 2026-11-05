import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderId } from "../adapters/shipping/provider";
import { loadSettings } from "../settings/service";
import { runLabRun, startLabRun } from "./runs";

/**
 * SPEC-rate-lab criterion 16: a 250-combination run against both fakes at 1 s latency finishes in
 * under 2 minutes, so combinations run `LAB_CONCURRENCY` at a time and providers in parallel.
 */

const db: Db = testDb();
const LATENCY_MS = 1_000;

/** Stores a fake's catalog as a sync would, with one domestic service on. */
async function catalog(provider: ProviderId, enabled: string) {
  for (const carrier of await createFakeShippingProvider(provider).listCarriers()) {
    await db.shippingCarrier.create({
      data: {
        provider,
        externalId: carrier.externalId,
        code: carrier.externalId,
        name: carrier.name,
        enabled: true,
        services: {
          create: carrier.services.map((s) => ({
            code: s.code,
            name: s.name,
            domestic: s.domestic,
            international: s.international,
            enabled: s.code === enabled,
            providerData: s.providerData as Prisma.InputJsonObject,
          })),
        },
      },
    });
  }
}

beforeAll(async () => {
  await resetDb(db);
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
afterAll(() => db.$disconnect());

describe("rate lab timing", () => {
  it("runs 25 addresses × 10 parcels against fakes at 1 s latency in under 2 minutes", async () => {
    await catalog("SHIPSTATION", "demo_ground");
    await catalog("BRIDGE_SOURCE", "GND");
    const value = (i: number) => ({
      name: `Customer ${i}`,
      address1: `${i} Main St`,
      city: "Denver",
      state: "CO",
      postalCode: "80202",
      country: "US",
    });
    await db.rateLabAddress.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        title: `Address ${i}`,
        original: value(i),
        address: value(i),
        residential: true,
        checkStatus: "VERIFIED" as const,
      })),
    });
    await db.rateLabParcel.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        title: `Parcel ${i}`,
        lengthIn: 10,
        widthIn: 8,
        heightIn: 4,
        weightOz: 10 + i,
      })),
    });
    const lab = await createActor(db, ["RATE_LAB"]);
    const slow = (id: ProviderId) => createFakeShippingProvider(id, { latencyMs: LATENCY_MS });
    const providers = [slow("SHIPSTATION"), slow("BRIDGE_SOURCE")];
    const empty = { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] };
    const run = await startLabRun(
      db,
      lab,
      { idempotencyKey: "bench-run-0001", selection: empty },
      { providers },
    );
    expect(run.combinations).toBe(250);

    const started = performance.now();
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "SUCCEEDED" });
    expect(performance.now() - started).toBeLessThan(120_000);
    expect(await db.rateFetch.count({ where: { labRunId: run.id } })).toBe(250);
  }, 150_000);
});
