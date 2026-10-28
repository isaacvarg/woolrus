import type { Db } from "@woolrus/db";
import { FakeShipStationProvider } from "../src/adapters/shipping/fake";
import { createActor } from "./db";
import { createOrder, createRate } from "./factories";

// A QA order the fake ShipStation can buy labels for: its catalog's "Demo Ground" service, rates
// that carry the fake's rate ids, an enabled provider account and a claim held by a QA user.

export async function demoService(db: Db) {
  const carrier =
    (await db.shippingCarrier.findFirst({ where: { externalId: "se-demo-ground" } })) ??
    (await db.shippingCarrier.create({
      data: {
        provider: "SHIPSTATION",
        externalId: "se-demo-ground",
        code: "demo_ground",
        name: "Demo Ground",
        enabled: true,
      },
    }));
  const service =
    (await db.carrierService.findFirst({
      where: { carrierId: carrier.id, code: "demo_ground" },
    })) ??
    (await db.carrierService.create({
      data: {
        carrierId: carrier.id,
        code: "demo_ground",
        name: "Demo Ground",
        domestic: true,
        international: false,
        enabled: true,
      },
    }));
  return { carrier, service };
}

/** A rate the fake provider accepts, for `packageId`. */
export async function demoRate(
  db: Db,
  packageId: string,
  { amountCents = 450, selected = false, expiresAt = new Date(Date.now() + 3_600_000) } = {},
) {
  const { carrier, service } = await demoService(db);
  return createRate(db, packageId, {
    carrierId: carrier.id,
    serviceId: service.id,
    carrierCode: "demo_ground",
    serviceCode: "demo_ground",
    serviceName: "Demo Ground",
    providerRateId: `se-rate:se-demo-ground:demo_ground:${amountCents}`,
    amountCents,
    selected,
    expiresAt,
  });
}

export async function enableShipStation(db: Db) {
  await db.shippingProviderAccount.upsert({
    where: { provider: "SHIPSTATION" },
    create: { provider: "SHIPSTATION", enabled: true },
    update: { enabled: true },
  });
  await db.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      shipFromAddress: {
        name: "Warehouse",
        phone: "5125550100",
        address1: "1 Dock Rd",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
    },
    update: {
      shipFromAddress: {
        name: "Warehouse",
        phone: "5125550100",
        address1: "1 Dock Rd",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
    },
  });
}

export const fakeProvider = () => new FakeShipStationProvider();
export const purchaseCalls = (provider: { requests: { operation: string }[] }) =>
  provider.requests.filter((r) => r.operation === "purchaseLabel").length;

/** A verified QA order with `count` packages, each with a selected $4.50 demo rate, claimed by a QA user. */
export async function verifiedQaOrder(db: Db, count = 2) {
  await enableShipStation(db);
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: "QA",
    claimedById: qa.userId,
    claimedAt: new Date(),
    lines: [{ quantity: count, pickStatus: "PICKED" }],
    packages: Array.from({ length: count }, () => ({
      items: [{ line: 0, quantity: 1, verified: true }],
    })),
  });
  await db.order.update({
    where: { id: built.order.id },
    data: {
      shipTo: {
        name: "Test Customer",
        address1: "1 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
    },
  });
  const rates = [];
  for (const p of built.packages) rates.push(await demoRate(db, p.id, { selected: true }));
  return { qa, ...built, rates };
}
