import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { FakeBridgeSourceProvider, FakeShipStationProvider } from "../adapters/shipping/fake";
import { createMemoryStorage } from "../adapters/storage/memory";
import { createManifest, getManifestPdf, manifestCandidates } from "./manifests";

// Manifests (SPEC-shipping "Manifests", FR-SHIP-14, success criterion 11).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const DAY = "2026-11-02";
const day = new Date(`${DAY}T00:00:00Z`);
const shipper = () => createActor(db, ["SHIPPER"]);

async function carrier(
  externalId = "se-1000002",
  provider: "SHIPSTATION" | "BRIDGE_SOURCE" = "SHIPSTATION",
) {
  return db.shippingCarrier.create({
    data: { provider, externalId, code: "usps", name: "USPS", enabled: true },
  });
}

let n = 0;
async function label(
  carrierId: string,
  overrides: {
    status?: "ACTIVE" | "VOIDED" | "PURCHASING";
    shipDate?: Date | null;
    orderStatus?: "COMPLETED" | "READY";
    manifestId?: string;
  } = {},
) {
  const { packages } = await createOrder(db, {
    status: overrides.orderStatus ?? "COMPLETED",
    packages: [{}],
  });
  n += 1;
  return db.shippingLabel.create({
    data: {
      packageId: packages[0]?.id,
      status: overrides.status ?? "ACTIVE",
      provider: "SHIPSTATION",
      idempotencyKey: `manifest-test-${n}-${crypto.randomUUID()}`,
      providerLabelId: `se-label-${n}`,
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      currency: "USD",
      carrierId,
      shipDate: overrides.shipDate === undefined ? day : overrides.shipDate,
      manifestId: overrides.manifestId ?? null,
    },
  });
}

function deps() {
  const provider = new FakeShipStationProvider();
  return { provider, providers: [provider], storage: createMemoryStorage() };
}

const key = () => crypto.randomUUID();

describe("manifestCandidates", () => {
  it("counts only the day's unmanifested ACTIVE labels of Completed orders, per carrier account", async () => {
    const usps = await carrier("se-1");
    const ups = await carrier("se-2");
    await label(usps.id);
    await label(usps.id);
    await label(ups.id);
    await label(usps.id, { status: "VOIDED" });
    await label(usps.id, { status: "PURCHASING" });
    await label(usps.id, { orderStatus: "READY" });
    await label(usps.id, { shipDate: new Date("2026-11-01T00:00:00Z") });
    await label(usps.id, { shipDate: null });
    const { providers } = deps();
    const result = await manifestCandidates(db, await shipper(), providers, { shipDate: DAY });
    const byCarrier = Object.fromEntries(result.carriers.map((c) => [c.carrierId, c.unmanifested]));
    expect(byCarrier).toEqual({ [usps.id]: 2, [ups.id]: 1 });
  });

  it("lists the day's existing manifests, and no label that already has one", async () => {
    const usps = await carrier();
    const { providers, storage } = deps();
    const actor = await shipper();
    await label(usps.id);
    const made = await createManifest(db, actor, providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });
    const result = await manifestCandidates(db, actor, providers, { shipDate: DAY });
    expect(result.carriers).toHaveLength(1);
    expect(result.carriers[0]).toMatchObject({ unmanifested: 0 });
    expect(result.carriers[0]?.manifests).toEqual([
      { id: made.manifestId, createdAt: expect.any(Date), labelCount: 1 },
    ]);
  });

  it("offers nothing for a provider without the manifests capability", async () => {
    const bridge = await carrier("BS-1", "BRIDGE_SOURCE");
    await label(bridge.id);
    const result = await manifestCandidates(db, await shipper(), [new FakeBridgeSourceProvider()], {
      shipDate: DAY,
    });
    expect(result.carriers).toEqual([]);
  });

  it("needs order.ship", async () => {
    const picker = await createActor(db, ["PICKER"]);
    await expect(
      manifestCandidates(db, picker, deps().providers, { shipDate: DAY }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("createManifest", () => {
  it("manifests exactly the candidates, stores the PDF and audits it", async () => {
    const usps = await carrier();
    const mine = [await label(usps.id), await label(usps.id)];
    const other = await label((await carrier("se-9")).id);
    await label(usps.id, { status: "VOIDED" });
    const { provider, providers, storage } = deps();
    const actor = await shipper();

    const made = await createManifest(db, actor, providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });

    expect(made.labelCount).toBe(2);
    const manifest = await db.manifest.findUniqueOrThrow({
      where: { id: made.manifestId },
      include: { labels: true },
    });
    expect(manifest.labels.map((l) => l.id).sort()).toEqual(mine.map((l) => l.id).sort());
    expect(manifest).toMatchObject({
      carrierId: usps.id,
      provider: "SHIPSTATION",
      createdById: actor.userId,
      storageKey: `manifests/${made.manifestId}.pdf`,
    });
    expect(manifest.shipDate.toISOString().slice(0, 10)).toBe(DAY);
    expect(storage.keys()).toEqual([`manifests/${made.manifestId}.pdf`]);
    expect(
      (await db.shippingLabel.findUniqueOrThrow({ where: { id: other.id } })).manifestId,
    ).toBeNull();
    expect(provider.requests.map((r) => r.operation)).toEqual(["findManifests", "createManifest"]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "manifest.create" } });
    expect(audit).toMatchObject({ entityType: "manifest", entityId: made.manifestId });
  });

  it("is idempotent for the same key and refuses when nothing is left to manifest", async () => {
    const usps = await carrier();
    await label(usps.id);
    const { provider, providers, storage } = deps();
    const actor = await shipper();
    const input = { carrierId: usps.id, shipDate: DAY, idempotencyKey: key() };
    const first = await createManifest(db, actor, providers, storage, input);
    const again = await createManifest(db, actor, providers, storage, input);
    expect(again).toEqual(first);
    expect(await db.manifest.count()).toBe(1);
    expect(provider.requests.filter((r) => r.operation === "createManifest")).toHaveLength(1);
    await expect(
      createManifest(db, actor, providers, storage, { ...input, idempotencyKey: key() }),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.shipping.noLabelsToManifest",
    });
  });

  it("puts a label shipped after the day's manifest into a second manifest", async () => {
    const usps = await carrier();
    await label(usps.id);
    const { providers, storage } = deps();
    const actor = await shipper();
    const first = await createManifest(db, actor, providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });
    const late = await label(usps.id);
    const second = await createManifest(db, actor, providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });
    expect(second.manifestId).not.toBe(first.manifestId);
    expect((await db.shippingLabel.findUniqueOrThrow({ where: { id: late.id } })).manifestId).toBe(
      second.manifestId,
    );
    expect(await db.manifest.count()).toBe(2);
  });

  it("finds the provider's manifest after a lost response instead of creating a second", async () => {
    const usps = await carrier();
    await label(usps.id);
    const { provider, providers, storage } = deps();
    const actor = await shipper();
    provider.loseNextManifestResponse();
    const made = await createManifest(db, actor, providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });
    expect(made.labelCount).toBe(1);
    const creates = provider.requests.filter((r) => r.operation === "createManifest");
    expect(creates).toHaveLength(1);
    expect(await db.manifest.count()).toBe(1);
  });

  it("adopts a manifest the provider already made for these labels, without creating another", async () => {
    const usps = await carrier();
    const mine = await label(usps.id);
    const { provider, providers, storage } = deps();
    // An earlier attempt created it at the provider, then lost both the response and the lookup.
    await provider.createManifest({
      carrierExternalId: usps.externalId,
      shipDate: DAY,
      providerLabelIds: [mine.providerLabelId as string],
    });
    const made = await createManifest(db, await shipper(), providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });
    expect(made.labelCount).toBe(1);
    expect(provider.requests.filter((r) => r.operation === "createManifest")).toHaveLength(1);
    expect(await db.manifest.count()).toBe(1);
  });

  it("writes nothing and returns the error key when the provider refuses", async () => {
    const usps = await carrier();
    const mine = await label(usps.id);
    const { provider, providers, storage } = deps();
    provider.failNext(400);
    await expect(
      createManifest(db, await shipper(), providers, storage, {
        carrierId: usps.id,
        shipDate: DAY,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: expect.stringMatching(/^errors\.shipping\./),
    });
    expect(await db.manifest.count()).toBe(0);
    expect(storage.keys()).toEqual([]);
    expect(
      (await db.shippingLabel.findUniqueOrThrow({ where: { id: mine.id } })).manifestId,
    ).toBeNull();
  });

  it("won't fetch a provider's form over plain http", async () => {
    const usps = await carrier();
    await label(usps.id);
    const { provider, providers, storage } = deps();
    provider.createManifest = async ({ providerLabelIds }) => ({
      providerManifestId: "se-manifest-http",
      providerLabelIds,
      document: { url: "http://example.com/form.pdf" },
    });
    let fetched = false;
    await expect(
      createManifest(
        db,
        await shipper(),
        providers,
        storage,
        { carrierId: usps.id, shipDate: DAY, idempotencyKey: key() },
        {
          fetch: async () => {
            fetched = true;
            return new Response("%PDF");
          },
        },
      ),
    ).rejects.toMatchObject({ messageKey: "errors.shipping.unavailable" });
    expect(fetched).toBe(false);
    expect(await db.manifest.count()).toBe(0);
  });

  it("refuses a provider without the capability and a user without order.ship", async () => {
    const bridge = await carrier("BS-1", "BRIDGE_SOURCE");
    await label(bridge.id);
    const { storage } = deps();
    const input = { carrierId: bridge.id, shipDate: DAY, idempotencyKey: key() };
    await expect(
      createManifest(db, await shipper(), [new FakeBridgeSourceProvider()], storage, input),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.shipping.manifestsUnsupported",
    });
    await expect(
      createManifest(db, await createActor(db, ["PICKER"]), deps().providers, storage, input),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("getManifestPdf", () => {
  it("returns the storage key for order.ship and refuses everyone else", async () => {
    const usps = await carrier();
    await label(usps.id);
    const { providers, storage } = deps();
    const made = await createManifest(db, await shipper(), providers, storage, {
      carrierId: usps.id,
      shipDate: DAY,
      idempotencyKey: key(),
    });
    const admin = await createActor(db, ["ADMIN"]);
    expect(await getManifestPdf(db, admin, { id: made.manifestId })).toEqual({
      key: `manifests/${made.manifestId}.pdf`,
    });
    const picker = await createActor(db, ["PICKER"]);
    await expect(getManifestPdf(db, picker, { id: made.manifestId })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(getManifestPdf(db, admin, { id: crypto.randomUUID() })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});
