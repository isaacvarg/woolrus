import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createCarrierService, createOrder, createRate } from "../../test/factories";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderId } from "../adapters/shipping/provider";
import type { UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { fetchRates, getOrderShipping } from "./rates";

/**
 * SPEC-carriers criterion 15: with fake providers at 2 s latency each, a 3-package order × 2
 * providers has rates stored in under 5 s (so the requests run in parallel, not serially), and
 * `getOrderShipping` reads 5 packages × 30 rates in under 300 ms at p95.
 */

const db: Db = testDb();
const LATENCY_MS = 2_000;
let qa: UserActor;

const p95 = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];

/** Stores a fake provider's catalog as a sync would, with every carrier and service on. */
async function catalog(provider: ProviderId) {
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
            enabled: true,
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
  qa = await createActor(db, ["QA"]);
});
afterAll(() => db.$disconnect());

describe("carriers timing", () => {
  it("stores rates for 3 packages × 2 providers at 2 s latency in under 5 s", async () => {
    await catalog("SHIPSTATION");
    await catalog("BRIDGE_SOURCE");
    const { order, packages } = await createOrder(db, {
      status: "QA",
      lines: [{ quantity: 3, pickStatus: "PICKED" }],
      packages: Array.from({ length: 3 }, () => ({
        items: [{ line: 0, quantity: 1 }],
        weightOz: 20,
      })),
    });
    await db.order.update({ where: { id: order.id }, data: { rateGeneration: 1 } });
    const slow = (id: ProviderId) => createFakeShippingProvider(id, { latencyMs: LATENCY_MS });

    // The fresh fetch checks the address first (one provider call in series), then rates.
    const started = performance.now();
    const result = await fetchRates(db, [slow("SHIPSTATION"), slow("BRIDGE_SOURCE")], {
      orderId: order.id,
      generation: 1,
    });
    const elapsed = performance.now() - started;

    expect(result).toEqual({ status: "done" });
    expect(elapsed).toBeLessThan(5_000);
    for (const pkg of packages) {
      const providers = await db.shippingRate.findMany({
        where: { packageId: pkg.id },
        distinct: ["provider"],
        select: { provider: true },
      });
      expect(providers.map((r) => r.provider).sort()).toEqual(["BRIDGE_SOURCE", "SHIPSTATION"]);
    }
  }, 15_000);

  it("reads an order's shipping of 5 packages × 30 rates under 300 ms at p95", async () => {
    const { order, packages } = await createOrder(db, {
      status: "QA",
      lines: [{ quantity: 5, pickStatus: "PICKED" }],
      packages: Array.from({ length: 5 }, () => ({
        items: [{ line: 0, quantity: 1 }],
        weightOz: 20,
      })),
    });
    const { carrier, service } = await createCarrierService(db);
    for (const pkg of packages) {
      await db.package.update({ where: { id: pkg.id }, data: { ratesStatus: "READY" } });
      for (let i = 0; i < 30; i += 1) {
        await createRate(db, pkg.id, {
          carrierId: carrier.id,
          serviceId: service.id,
          amountCents: 500 + i,
          selected: i === 0,
        });
      }
    }

    const times: number[] = [];
    for (let run = 0; run < 30; run += 1) {
      const start = performance.now();
      const shipping = await getOrderShipping(db, qa, { orderId: order.id });
      times.push(performance.now() - start);
      expect(shipping.packages.flatMap((p) => p.rates)).toHaveLength(150);
    }
    expect(p95(times)).toBeLessThan(300);
  });
});
