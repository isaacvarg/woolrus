import { randomBytes } from "node:crypto";
import { SetCarrierLabelInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, createRate } from "../../test/factories";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderCarrier, ProviderId } from "../adapters/shipping/provider";
import type { AdapterFactories } from "../adapters/shipping/registry";
import type { Actor } from "../permissions";
import {
  listShippingConfig,
  listUsableServices,
  setCarrierEnabled,
  setCarrierLabel,
  setServiceEnabled,
  syncCarriers,
} from "./carriers";
import { setProviderCredentials, setProviderEnabled } from "./providers";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SHIPPING_PROVIDERS", undefined);
  vi.stubEnv("SHIPSTATION_API_KEY", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const credentials = {
  SHIPSTATION: { provider: "SHIPSTATION", credentials: { apiKey: "key" } },
  BRIDGE_SOURCE: { provider: "BRIDGE_SOURCE", credentials: { apiKey: "key", customerId: "C-1" } },
} as const;

/**
 * Both fakes as the build's adapters. `drop` hides carriers (by externalId) and services (by
 * code) from `listCarriers`, as a provider that stopped offering them would.
 */
function fakeAdapters() {
  const drop = new Set<string>();
  const factory = (id: ProviderId) => (creds: Record<string, string>) => {
    const provider = createFakeShippingProvider(id, { credentials: creds });
    const list = provider.listCarriers.bind(provider);
    provider.listCarriers = async (): Promise<ProviderCarrier[]> =>
      (await list())
        .filter((c) => !drop.has(c.externalId))
        .map((c) => ({ ...c, services: c.services.filter((s) => !drop.has(s.code)) }));
    return provider;
  };
  const adapters: AdapterFactories = {
    SHIPSTATION: factory("SHIPSTATION"),
    BRIDGE_SOURCE: factory("BRIDGE_SOURCE"),
  };
  return { adapters, drop };
}

const admin = () => createActor(db, ["ADMIN"]);

async function enabledProvider(actor: Actor, id: ProviderId, adapters: AdapterFactories) {
  await setProviderCredentials(db, actor, credentials[id]);
  await setProviderEnabled(db, actor, { provider: id, enabled: true }, adapters);
}

async function configFor(actor: Actor, id: ProviderId) {
  const config = await listShippingConfig(db, actor);
  const entry = config.find((p) => p.provider === id);
  if (!entry) throw new Error(`no config for ${id}`);
  return entry;
}

describe.each(["SHIPSTATION", "BRIDGE_SOURCE"] as const)("syncCarriers (%s fake)", (id) => {
  it("adds every carrier and service the provider lists, disabled", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await enabledProvider(actor, id, adapters);
    const listed = await adapters[id]?.(credentials[id].credentials as never, {}).listCarriers();
    const serviceCount = listed?.flatMap((c) => c.services).length ?? 0;

    const result = await syncCarriers(db, actor, { provider: id }, adapters);

    expect(result).toEqual({
      carriersAdded: listed?.length,
      servicesAdded: serviceCount,
      carriersMissing: 0,
      servicesMissing: 0,
    });
    const { carriers, lastSyncedAt } = await configFor(actor, id);
    expect(lastSyncedAt).toBeInstanceOf(Date);
    expect(carriers).toHaveLength(listed?.length ?? -1);
    // Stored with the carrier's own code, which tracking and the Woo push use.
    const rows = await db.shippingCarrier.findMany({ where: { provider: id } });
    expect(rows.map((r) => r.code).sort()).toEqual(listed?.map((c) => c.code).sort());
    for (const carrier of carriers) {
      expect(carrier).toMatchObject({ enabled: false, missing: false });
      for (const service of carrier.services) {
        expect(service).toMatchObject({ enabled: false, missing: false });
      }
    }
    const stored = await db.carrierService.findMany({ where: { carrier: { provider: id } } });
    expect(stored).toHaveLength(serviceCount);
    expect(await listUsableServices(db, id)).toEqual([]);
  });

  it("keeps the switches on a re-sync", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await enabledProvider(actor, id, adapters);
    await syncCarriers(db, actor, { provider: id }, adapters);
    const [carrier] = (await configFor(actor, id)).carriers;
    const [service] = carrier?.services ?? [];
    if (!carrier || !service) throw new Error("nothing synced");
    await setCarrierEnabled(db, actor, { id: carrier.id, enabled: true });
    await setServiceEnabled(db, actor, { id: service.id, enabled: true });

    const result = await syncCarriers(db, actor, { provider: id }, adapters);

    expect(result).toMatchObject({ carriersAdded: 0, servicesAdded: 0 });
    const after = (await configFor(actor, id)).carriers.find((c) => c.id === carrier.id);
    expect(after?.enabled).toBe(true);
    expect(after?.services.find((s) => s.id === service.id)?.enabled).toBe(true);
    expect((await listUsableServices(db, id)).map((s) => s.id)).toEqual([service.id]);
  });

  it("marks what the provider no longer lists, never sends it, and keeps its rates", async () => {
    const actor = await admin();
    const { adapters, drop } = fakeAdapters();
    await enabledProvider(actor, id, adapters);
    await syncCarriers(db, actor, { provider: id }, adapters);
    const carriers = (await configFor(actor, id)).carriers;
    for (const carrier of carriers) {
      await setCarrierEnabled(db, actor, { id: carrier.id, enabled: true });
      for (const service of carrier.services) {
        await setServiceEnabled(db, actor, { id: service.id, enabled: true });
      }
    }
    const [dropped, kept] = carriers;
    if (!dropped || !kept || kept.services.length < 2) throw new Error("fake catalog too small");
    const droppedService = kept.services[0];
    if (!droppedService) throw new Error("no service");
    const carrierRow = await db.shippingCarrier.findUniqueOrThrow({ where: { id: dropped.id } });
    drop.add(carrierRow.externalId);
    drop.add(droppedService.code);
    const {
      packages: [pkg],
    } = await createOrder(db, { packages: [{}] });
    if (!pkg) throw new Error("no package");
    const rate = await createRate(db, pkg.id, {
      provider: id,
      carrierId: dropped.id,
      serviceId: dropped.services[0]?.id,
    });

    const result = await syncCarriers(db, actor, { provider: id }, adapters);

    expect(result).toEqual({
      carriersAdded: 0,
      servicesAdded: 0,
      carriersMissing: 1,
      servicesMissing: dropped.services.length + 1,
    });
    const after = (await configFor(actor, id)).carriers;
    expect(after.find((c) => c.id === dropped.id)).toMatchObject({ missing: true, enabled: true });
    expect(
      after.find((c) => c.id === kept.id)?.services.find((s) => s.id === droppedService.id),
    ).toMatchObject({ missing: true, enabled: true });
    const usable = (await listUsableServices(db, id)).map((s) => s.id);
    expect(usable).not.toContain(droppedService.id);
    expect(usable.some((s) => dropped.services.some((d) => d.id === s))).toBe(false);
    expect(usable).toHaveLength(kept.services.length - 1);
    // Never deleted: the old rate still loads with its carrier and service.
    const loaded = await db.shippingRate.findUniqueOrThrow({
      where: { id: rate.id },
      include: { carrier: true, service: true },
    });
    expect(loaded.carrier.id).toBe(dropped.id);

    // Still gone on the next sync: counted once, and the date it went missing stays.
    const since = (await db.shippingCarrier.findUniqueOrThrow({ where: { id: dropped.id } }))
      .missingSince;
    expect(await syncCarriers(db, actor, { provider: id }, adapters)).toMatchObject({
      carriersMissing: 0,
      servicesMissing: 0,
    });
    expect(
      (await db.shippingCarrier.findUniqueOrThrow({ where: { id: dropped.id } })).missingSince,
    ).toEqual(since);

    // Listed again, it comes back with its switches as they were.
    drop.clear();
    await syncCarriers(db, actor, { provider: id }, adapters);
    expect((await listUsableServices(db, id)).length).toBe(
      carriers.flatMap((c) => c.services).length,
    );
  });
});

describe("syncCarriers", () => {
  it("audits each sync with its counts", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await enabledProvider(actor, "SHIPSTATION", adapters);
    const result = await syncCarriers(db, actor, { provider: "SHIPSTATION" }, adapters);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityType: "ShippingProviderAccount", entityId: "SHIPSTATION", action: "sync" },
    });
    expect(audit.actorId).toBe(actor.userId);
    expect(audit.after).toEqual({ provider: "SHIPSTATION", ...result });
  });

  it("refuses a provider that is off, and changes nothing", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await setProviderCredentials(db, actor, credentials.SHIPSTATION);

    await expect(
      syncCarriers(db, actor, { provider: "SHIPSTATION" }, adapters),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.carriers.providerOff" });
    expect(await db.shippingCarrier.count()).toBe(0);
  });

  it("reports the provider's error and changes nothing when listing fails", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await enabledProvider(actor, "SHIPSTATION", adapters);
    const failing: AdapterFactories = {
      SHIPSTATION: (creds, config) => {
        const provider = createFakeShippingProvider("SHIPSTATION", { credentials: creds });
        provider.failNext(500);
        void config;
        return provider;
      },
    };

    await expect(
      syncCarriers(db, actor, { provider: "SHIPSTATION" }, failing),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.shipping.unavailable" });
    expect(await db.shippingCarrier.count()).toBe(0);
    expect(await db.auditEvent.count({ where: { action: "sync" } })).toBe(0);
  });
});

describe("carrier accounts", () => {
  /** Two UPS accounts in one ShipStation, as the provider lists them. */
  function upsAccounts(): AdapterFactories {
    const ups = (externalId: string, extra: Partial<ProviderCarrier>): ProviderCarrier => ({
      externalId,
      code: "ups",
      name: "UPS",
      services: ["ups_ground", "ups_standard"].map((code) => ({
        code,
        name: code,
        domestic: true,
        international: false,
        providerData: {},
      })),
      ...extra,
    });
    return {
      SHIPSTATION: (creds) => {
        const provider = createFakeShippingProvider("SHIPSTATION", { credentials: creds });
        provider.listCarriers = async () => [
          ups("se-1", { nickname: "UPS EBC", accountSuffix: "8w00" }),
          ups("se-2", { billedByProvider: true }),
        ];
        return provider;
      },
    };
  }

  async function syncedAccounts() {
    const actor = await admin();
    const adapters = upsAccounts();
    await enabledProvider(actor, "SHIPSTATION", adapters);
    await syncCarriers(db, actor, { provider: "SHIPSTATION" }, adapters);
    const { carriers } = await configFor(actor, "SHIPSTATION");
    const byId = async (externalId: string) => {
      const row = await db.shippingCarrier.findUniqueOrThrow({
        where: { provider_externalId: { provider: "SHIPSTATION", externalId } },
      });
      const config = carriers.find((c) => c.id === row.id);
      if (!config) throw new Error(`no config for ${externalId}`);
      return config;
    };
    return { actor, adapters, first: await byId("se-1"), second: await byId("se-2") };
  }

  it("keeps what the provider says about each account, unlabelled", async () => {
    const { first, second } = await syncedAccounts();
    expect(first).toMatchObject({
      name: "UPS",
      label: null,
      providerNickname: "UPS EBC",
      accountSuffix: "8w00",
      billedByProvider: false,
    });
    expect(second).toMatchObject({
      providerNickname: null,
      accountSuffix: null,
      billedByProvider: true,
    });
  });

  it("notes a service whose provider flags mislead, and only that one", async () => {
    const { first } = await syncedAccounts();
    const notes = Object.fromEntries(first.services.map((s) => [s.code, s.note]));
    expect(notes).toEqual({ ups_ground: null, ups_standard: "usCanadaMexico" });
  });

  // Through the input schema, as the router parses it: it trims, and an empty label clears.
  const relabel = (actor: Actor, id: string, label: string) =>
    setCarrierLabel(db, actor, SetCarrierLabelInput.parse({ id, label }));

  it("sets, trims and clears a label, auditing each change and not a no-op", async () => {
    const { actor, first } = await syncedAccounts();

    const set = await relabel(actor, first.id, "  Negotiated ");
    expect(set.label).toBe("Negotiated");
    await relabel(actor, first.id, "Negotiated");
    const cleared = await relabel(actor, first.id, " ");
    expect(cleared.label).toBeNull();

    const events = await db.auditEvent.findMany({
      where: { entityType: "ShippingCarrier", action: "relabel" },
      orderBy: { at: "asc" },
    });
    expect(events.map((e) => [e.before, e.after])).toEqual([
      [{ label: null }, { label: "Negotiated" }],
      [{ label: "Negotiated" }, { label: null }],
    ]);
  });

  it("keeps the label on a re-sync", async () => {
    const { actor, adapters, first } = await syncedAccounts();
    await relabel(actor, first.id, "Negotiated");
    await syncCarriers(db, actor, { provider: "SHIPSTATION" }, adapters);
    const row = await db.shippingCarrier.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ label: "Negotiated", providerNickname: "UPS EBC" });
  });

  it("refuses a label over 60 characters", () => {
    const id = "01900000-0000-7000-8000-000000000000";
    expect(SetCarrierLabelInput.safeParse({ id, label: "x".repeat(61) }).success).toBe(false);
  });
});

describe("setCarrierEnabled / setServiceEnabled", () => {
  async function synced() {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await enabledProvider(actor, "SHIPSTATION", adapters);
    await syncCarriers(db, actor, { provider: "SHIPSTATION" }, adapters);
    const [carrier] = (await configFor(actor, "SHIPSTATION")).carriers;
    const service = carrier?.services[0];
    if (!carrier || !service) throw new Error("nothing synced");
    return { actor, carrier, service };
  }

  it("uses a service only when it and its carrier are both on", async () => {
    const { actor, carrier, service } = await synced();

    await setServiceEnabled(db, actor, { id: service.id, enabled: true });
    expect(await listUsableServices(db, "SHIPSTATION")).toEqual([]);

    await setCarrierEnabled(db, actor, { id: carrier.id, enabled: true });
    const usable = await listUsableServices(db, "SHIPSTATION");
    expect(usable.map((s) => s.id)).toEqual([service.id]);
    expect(usable[0]?.carrier.id).toBe(carrier.id);

    await setServiceEnabled(db, actor, { id: service.id, enabled: false });
    expect(await listUsableServices(db, "SHIPSTATION")).toEqual([]);
  });

  it("audits each change, and not a switch to the state it's already in", async () => {
    const { actor, carrier, service } = await synced();

    await setCarrierEnabled(db, actor, { id: carrier.id, enabled: true });
    await setServiceEnabled(db, actor, { id: service.id, enabled: true });
    await setServiceEnabled(db, actor, { id: service.id, enabled: false });
    await setCarrierEnabled(db, actor, { id: carrier.id, enabled: true });

    const events = await db.auditEvent.findMany({
      where: { entityType: { in: ["ShippingCarrier", "CarrierService"] } },
      orderBy: { at: "asc" },
    });
    expect(events.map((e) => [e.entityType, e.entityId, e.action])).toEqual([
      ["ShippingCarrier", carrier.id, "enable"],
      ["CarrierService", service.id, "enable"],
      ["CarrierService", service.id, "disable"],
    ]);
  });

  it("returns not found for an unknown id", async () => {
    const actor = await admin();
    const id = "01900000-0000-7000-8000-000000000000";
    await expect(setCarrierEnabled(db, actor, { id, enabled: true })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(setServiceEnabled(db, actor, { id, enabled: true })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});

describe("permissions", () => {
  const id = "01900000-0000-7000-8000-000000000000";
  const calls = {
    syncCarriers: (actor: Actor) =>
      syncCarriers(db, actor, { provider: "SHIPSTATION" }, fakeAdapters().adapters),
    setCarrierEnabled: (actor: Actor) => setCarrierEnabled(db, actor, { id, enabled: true }),
    setCarrierLabel: (actor: Actor) => setCarrierLabel(db, actor, { id, label: "Negotiated" }),
    setServiceEnabled: (actor: Actor) => setServiceEnabled(db, actor, { id, enabled: true }),
    listShippingConfig: (actor: Actor) => listShippingConfig(db, actor),
  };

  it("allows an admin past the permission check", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await enabledProvider(actor, "SHIPSTATION", adapters);
    await expect(calls.syncCarriers(actor)).resolves.toBeDefined();
    await expect(calls.listShippingConfig(actor)).resolves.toBeDefined();
    // Past the check, an unknown id is not found rather than forbidden.
    await expect(calls.setCarrierEnabled(actor)).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(calls.setCarrierLabel(actor)).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(calls.setServiceEnabled(actor)).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it.each(
    Object.keys(calls).flatMap((name) =>
      (["PICKER", "PACKER", "QA", "SHIPPER"] as const).map((role) => [name, role] as const),
    ),
  )("forbids %s to %s", async (name, role) => {
    const actor = await createActor(db, [role]);
    await expect(calls[name as keyof typeof calls](actor)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});
