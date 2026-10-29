import { createFakeShippingProvider, createMemoryStorage, purchaseLabels } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { createOrder } from "./orders";
import { ensureShipFrom } from "./rates";

const db = createDb();

const shipTo = {
  name: "E2E Customer",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

/** The fake ShipStation's "Demo Ground" service, which is what its purchases accept. */
async function demoService() {
  const existing = await db.shippingCarrier.findFirst({ where: { externalId: "se-demo-ground" } });
  const carrier =
    existing ??
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
  return { carrier, service, created: !existing };
}

/**
 * A QA order claimed by `qaUserId`: one unit per package (so `packages` units of a product whose SKU
 * a scanner can read), each package with a $4.50 selected and a $6.00 alternative demo rate. Call
 * it inside `withSettingsLock`: it enables ShipStation, and `cleanup` puts that back.
 */
export async function qaJourneyOrder({
  qaUserId,
  packages = 1,
  address2,
  shippingChargedCents = 1000,
}: {
  qaUserId: string;
  packages?: number;
  address2?: string;
  shippingChargedCents?: number;
}) {
  await ensureShipFrom();
  const before = await db.shippingProviderAccount.findUnique({
    where: { provider: "SHIPSTATION" },
  });
  await db.shippingProviderAccount.upsert({
    where: { provider: "SHIPSTATION" },
    create: { provider: "SHIPSTATION", enabled: true },
    update: { enabled: true },
  });
  const { carrier, service, created } = await demoService();

  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    status: "QA",
    quantity: packages,
    ownProduct: true,
  });
  await db.order.update({
    where: { id: order.id },
    data: {
      claimedById: qaUserId,
      claimedAt: new Date(),
      shippingChargedCents,
      shipTo: { ...shipTo, ...(address2 ? { address2 } : {}) },
    },
  });
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const packageIds: string[] = [];
  for (let number = 1; number <= packages; number++) {
    const pkg = await db.package.create({
      data: { orderId: order.id, number, weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 },
    });
    packageIds.push(pkg.id);
    await db.packageItem.create({ data: { packageId: pkg.id, orderItemId: line.id, quantity: 1 } });
    for (const amountCents of [450, 600]) {
      await db.shippingRate.create({
        data: {
          packageId: pkg.id,
          provider: "SHIPSTATION",
          carrierId: carrier.id,
          serviceId: service.id,
          carrierCode: "demo_ground",
          serviceCode: "demo_ground",
          serviceName: "Demo Ground",
          providerRateId: `se-rate:se-demo-ground:demo_ground:${amountCents}`,
          amountCents,
          currency: "USD",
          selected: amountCents === 450,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }
  }

  return {
    order,
    customerName,
    sku: line.sku as string,
    packageIds,
    /** Runs the `labels.purchase` job as the worker would (CI starts none), against the fake. */
    async runPurchase(requestedById: string, providerLabels = new Map()) {
      const provider = createFakeShippingProvider("SHIPSTATION", { labels: providerLabels });
      await purchaseLabels(
        db,
        { providers: [provider], storage: createMemoryStorage() },
        { orderId: order.id, requestedById },
      );
    },
    async cleanup() {
      await db.shippingLabel.deleteMany({ where: { package: { orderId: order.id } } });
      await db.shippingRate.deleteMany({ where: { packageId: { in: packageIds } } });
      await db.order.update({ where: { id: order.id }, data: { claimedById: null } });
      if (created) {
        await db.carrierService.deleteMany({ where: { carrierId: carrier.id } });
        await db.shippingCarrier.deleteMany({ where: { id: carrier.id } });
      }
      await db.shippingProviderAccount.update({
        where: { provider: "SHIPSTATION" },
        data: { enabled: before?.enabled ?? false },
      });
    },
  };
}
