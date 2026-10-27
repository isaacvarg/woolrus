import type { Db, LabelStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createCarrierService, createOrder, createRate } from "../../test/factories";

// The provider-neutral shipping schema (SPEC-carriers "Schema changes"). The init migration's
// hand-written constraints must survive it, so each one is proven here.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

async function onePackage() {
  const { order, packages } = await createOrder(db, { status: "QA", packages: [{}] });
  const pkg = packages[0];
  if (!pkg) throw new Error("no package");
  return { order, pkg };
}

function label(packageId: string | null, returnId: string | null, status: LabelStatus = "ACTIVE") {
  return db.shippingLabel.create({
    data: {
      packageId,
      returnId,
      status,
      provider: "SHIPSTATION",
      idempotencyKey: crypto.randomUUID(),
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      currency: "USD",
    },
  });
}

describe("hand-written constraints from the init migration", () => {
  it("allows at most one selected rate per package", async () => {
    const { pkg } = await onePackage();
    await createRate(db, pkg.id, { selected: true });
    await createRate(db, pkg.id, { selected: false });
    await expect(createRate(db, pkg.id, { selected: true })).rejects.toThrow();
  });

  it("allows at most one live label per package", async () => {
    const { pkg } = await onePackage();
    await label(pkg.id, null, "VOIDED");
    await label(pkg.id, null, "ACTIVE");
    await expect(label(pkg.id, null, "PURCHASING")).rejects.toThrow();
  });

  it("puts a label on exactly one of a package or a return", async () => {
    const { order, pkg } = await onePackage();
    const ret = await db.returnRequest.create({
      data: { orderId: order.id, rmaNumber: "RMA-1", reason: "Damaged" },
    });
    await expect(label(null, null)).rejects.toThrow();
    await expect(label(pkg.id, ret.id)).rejects.toThrow();
    await expect(label(null, ret.id)).resolves.toMatchObject({ returnId: ret.id });
  });
});

describe("provider-neutral shipping tables", () => {
  it("keys carriers by provider and external id", async () => {
    await db.shippingCarrier.create({
      data: { provider: "SHIPSTATION", externalId: "se-1", code: "usps", name: "USPS" },
    });
    await db.shippingCarrier.create({
      data: { provider: "BRIDGE_SOURCE", externalId: "se-1", code: "usps", name: "USPS" },
    });
    await expect(
      db.shippingCarrier.create({
        data: { provider: "SHIPSTATION", externalId: "se-1", code: "usps", name: "Again" },
      }),
    ).rejects.toThrow();
  });

  it("gives a service provider data and no missing date by default", async () => {
    const { carrier, service } = await createCarrierService(db);
    expect(carrier.missingSince).toBeNull();
    expect(service).toMatchObject({ providerData: {}, missingSince: null });
  });

  it("ties a rate to its provider, carrier and service, with an optional rate id", async () => {
    const { pkg } = await onePackage();
    const rate = await createRate(db, pkg.id, { providerRateId: null });
    const loaded = await db.shippingRate.findUniqueOrThrow({
      where: { id: rate.id },
      include: { carrier: true, service: true },
    });
    expect(loaded).toMatchObject({ provider: "SHIPSTATION", providerRateId: null });
    expect(loaded.service.carrierId).toBe(loaded.carrier.id);
  });

  it("keeps a carrier with rates from being deleted", async () => {
    const { pkg } = await onePackage();
    const rate = await createRate(db, pkg.id);
    await expect(db.shippingCarrier.delete({ where: { id: rate.carrierId } })).rejects.toThrow();
  });

  it("makes a label id unique per provider", async () => {
    const { pkg } = await onePackage();
    const a = await label(pkg.id, null, "VOIDED");
    const b = await label(pkg.id, null, "VOIDED");
    await db.shippingLabel.update({ where: { id: a.id }, data: { providerLabelId: "L1" } });
    await expect(
      db.shippingLabel.update({ where: { id: b.id }, data: { providerLabelId: "L1" } }),
    ).rejects.toThrow();
    await db.shippingLabel.update({
      where: { id: b.id },
      data: { provider: "BRIDGE_SOURCE", providerLabelId: "L1", storageKey: "labels/b.pdf" },
    });
  });

  it("makes a manifest id unique per provider", async () => {
    const { carrier } = await createCarrierService(db);
    const manifest = (provider: "SHIPSTATION" | "BRIDGE_SOURCE") =>
      db.manifest.create({
        data: { carrierId: carrier.id, provider, providerManifestId: "M1", shipDate: new Date() },
      });
    await manifest("SHIPSTATION");
    await manifest("BRIDGE_SOURCE");
    await expect(manifest("SHIPSTATION")).rejects.toThrow();
  });

  it("starts packages with no rates and orders with an unchecked ship-to", async () => {
    const { order, pkg } = await onePackage();
    expect(pkg).toMatchObject({ ratesStatus: "NONE", ratesFetchedAt: null, rateErrors: [] });
    expect(order).toMatchObject({
      shipTo: null,
      shipToOriginal: null,
      shipToStatus: "UNCHECKED",
      shipToMessages: [],
      shipToCheckedAt: null,
      rateGeneration: 0,
    });
  });

  it("has one account per provider, disabled with empty config", async () => {
    const account = await db.shippingProviderAccount.create({ data: { provider: "SHIPSTATION" } });
    expect(account).toMatchObject({
      enabled: false,
      credentialsEnc: null,
      config: {},
      lastCheckedAt: null,
      lastErrorKey: null,
    });
    await expect(
      db.shippingProviderAccount.create({ data: { provider: "SHIPSTATION" } }),
    ).rejects.toThrow();
  });

  it("keeps no ShipStation column: the key moved to its provider account", async () => {
    const rows = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%shipstation%'`;
    expect(rows).toEqual([]);
  });
});
