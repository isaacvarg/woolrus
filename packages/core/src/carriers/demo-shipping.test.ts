import type { Db } from "@woolrus/db";
import { Prisma } from "@woolrus/db";
import { seedDemoOrders } from "@woolrus/db/demo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { Actor } from "../permissions";
import { loadSettings } from "../settings/service";
import { fetchRates, getOrderShipping } from "./rates";

// SPEC-carriers "Dev data": the seed creates both provider accounts (disabled) and, with
// SHIPPING_PROVIDERS=fake, rates the demo QA orders from both fakes. The seed can't call core, so
// it writes what the fakes would answer; these tests hold it to the real fakes.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let qa: Actor;
beforeEach(async () => {
  await resetDb(db);
  qa = await createActor(db, ["QA"]);
});

const qaOrders = () => db.order.findMany({ where: { status: "QA" }, orderBy: { number: "asc" } });

/** What a rate fetch decides, without the parts that depend on when or which run it was. */
async function fetched(orderId: string) {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      packages: {
        orderBy: { number: "asc" },
        include: { rates: { orderBy: [{ amountCents: "asc" }, { provider: "asc" }] } },
      },
    },
  });
  return {
    shipTo: order.shipTo,
    shipToOriginal: order.shipToOriginal,
    shipToStatus: order.shipToStatus,
    shipToMessages: order.shipToMessages,
    packages: order.packages.map((pkg) => ({
      ratesStatus: pkg.ratesStatus,
      rateErrors: pkg.rateErrors,
      rates: pkg.rates.map((r) => ({
        provider: r.provider,
        carrierId: r.carrierId,
        serviceId: r.serviceId,
        providerRateId: r.providerRateId,
        carrierCode: r.carrierCode,
        serviceCode: r.serviceCode,
        serviceName: r.serviceName,
        amountCents: r.amountCents,
        currency: r.currency,
        deliveryDays: r.deliveryDays,
        guaranteed: r.guaranteed,
        trackable: r.trackable,
        selected: r.selected,
      })),
    })),
  };
}

describe("demo shipping data", () => {
  it("creates both provider accounts, disabled and without credentials", async () => {
    await seedDemoOrders(db);

    const accounts = await db.shippingProviderAccount.findMany({ orderBy: { provider: "asc" } });
    expect(accounts.map((a) => [a.provider, a.enabled, a.credentialsEnc])).toEqual([
      ["SHIPSTATION", false, null],
      ["BRIDGE_SOURCE", false, null],
    ]);

    // Re-running leaves an account someone set up alone.
    await db.shippingProviderAccount.update({
      where: { provider: "SHIPSTATION" },
      data: { enabled: true },
    });
    await seedDemoOrders(db, { fakeShipping: true });
    expect(
      (await db.shippingProviderAccount.findUniqueOrThrow({ where: { provider: "SHIPSTATION" } }))
        .enabled,
    ).toBe(true);
  });

  it("with fake providers, rates every QA package from both, cheapest selected", async () => {
    await seedDemoOrders(db, { fakeShipping: true });

    const orders = await qaOrders();
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) {
      const shipping = await getOrderShipping(db, qa, { orderId: order.id });
      for (const pkg of shipping.packages) {
        expect(pkg.ratesStatus, order.number).toBe("READY");
        expect(new Set(pkg.rates.map((r) => r.provider))).toEqual(
          new Set(["SHIPSTATION", "BRIDGE_SOURCE"]),
        );
        expect(pkg.rates.filter((r) => r.selected)).toEqual([pkg.rates[0]]);
        expect(pkg.rates.every((r) => !r.expired)).toBe(true);
      }
    }
  });

  it("with fake providers, shows one QA order's corrected address beside the original", async () => {
    await seedDemoOrders(db, { fakeShipping: true });

    const corrected = (await qaOrders()).filter((o) => o.shipToStatus === "CORRECTED");
    expect(corrected).toHaveLength(1);
    const shipping = await getOrderShipping(db, qa, { orderId: corrected[0]?.id as string });
    expect(shipping.shipTo.original?.address1).toMatch(/\bStreet\b/);
    expect(shipping.shipTo.address?.address1).toBe(
      shipping.shipTo.original?.address1?.replace(/\bStreet\b/, "St"),
    );
  });

  it("stores what the fakes answer, so a refresh changes nothing but timestamps", async () => {
    await seedDemoOrders(db, { fakeShipping: true });
    expect((await loadSettings(db)).shipFromAddress).not.toBeNull();

    for (const order of await qaOrders()) {
      const seeded = await fetched(order.id);
      // Resolve and check the address again too, as a fresh fetch does.
      const { rateGeneration } = await db.order.update({
        where: { id: order.id },
        data: { shipTo: Prisma.DbNull, rateGeneration: { increment: 1 } },
      });
      const providers = [
        createFakeShippingProvider("SHIPSTATION"),
        createFakeShippingProvider("BRIDGE_SOURCE"),
      ];
      await fetchRates(db, providers, { orderId: order.id, generation: rateGeneration });

      expect(await fetched(order.id), order.number).toEqual(seeded);
    }
  });

  it("without fake providers, adds no provider catalogs or ship-to", async () => {
    await seedDemoOrders(db);

    expect(
      await db.shippingCarrier.count({
        where: { externalId: { in: ["se-demo-ground", "DEMOGND"] } },
      }),
    ).toBe(0);
    expect(await db.order.count({ where: { shipTo: { not: Prisma.DbNull } } })).toBe(0);
  });
});
