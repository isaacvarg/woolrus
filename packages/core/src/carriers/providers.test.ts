import { randomBytes } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderId, ShippingProvider } from "../adapters/shipping/provider";
import type { AdapterFactories } from "../adapters/shipping/registry";
import { decryptSecret } from "../settings/crypto";
import {
  clearProviderCredentials,
  listProviders,
  setProviderCredentials,
  setProviderEnabled,
  shippingProviderHealth,
  testProvider,
  updateProviderConfig,
} from "./providers";

const db: Db = testDb();
const key = randomBytes(32);
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", key.toString("base64"));
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SHIPPING_PROVIDERS", undefined);
  vi.stubEnv("SHIPSTATION_API_KEY", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const SECRET = "ss_live_7c6b5a4d3e2f1QZXJ";
const shipStation = { provider: "SHIPSTATION", credentials: { apiKey: SECRET } } as const;
const bridge = {
  provider: "BRIDGE_SOURCE",
  credentials: { apiKey: `${SECRET}-bs`, customerId: "C-100" },
} as const;

/** Both providers' fakes as the build's adapters, counting pings. */
function fakeAdapters(only?: ProviderId) {
  const pings: ProviderId[] = [];
  const factory = (id: ProviderId) => (credentials: Record<string, string>) => {
    const provider = createFakeShippingProvider(id, { credentials });
    const ping = provider.ping.bind(provider);
    provider.ping = () => {
      pings.push(id);
      return ping();
    };
    return provider;
  };
  const adapters: AdapterFactories = {};
  if (!only || only === "SHIPSTATION") adapters.SHIPSTATION = factory("SHIPSTATION");
  if (!only || only === "BRIDGE_SOURCE") adapters.BRIDGE_SOURCE = factory("BRIDGE_SOURCE");
  return { adapters, pings };
}

const admin = () => createActor(db, ["ADMIN"]);

async function accountRow(provider: ProviderId) {
  return db.shippingProviderAccount.findUniqueOrThrow({ where: { provider } });
}

describe("listProviders", () => {
  it("creates every provider on first read, disabled and without credentials", async () => {
    const { adapters } = fakeAdapters("SHIPSTATION");
    const providers = await listProviders(db, await admin(), adapters);

    expect(providers).toEqual([
      {
        provider: "SHIPSTATION",
        enabled: false,
        adapterAvailable: true,
        credentials: { apiKey: { configured: false } },
        config: { baseUrl: null },
        lastCheckedAt: null,
        lastErrorKey: null,
        carrierCount: 0,
      },
      {
        provider: "BRIDGE_SOURCE",
        enabled: false,
        adapterAvailable: false,
        credentials: { apiKey: { configured: false }, customerId: { configured: false } },
        config: { baseUrl: null },
        lastCheckedAt: null,
        lastErrorKey: null,
        carrierCount: 0,
      },
    ]);
    expect(await db.shippingProviderAccount.count()).toBe(2);
  });

  it("counts each provider's carriers", async () => {
    await db.shippingCarrier.createMany({
      data: [
        { provider: "SHIPSTATION", externalId: "se-1", code: "ups", name: "UPS" },
        { provider: "SHIPSTATION", externalId: "se-2", code: "usps", name: "USPS" },
        { provider: "BRIDGE_SOURCE", externalId: "FDX", code: "fdx", name: "FedEx" },
      ],
    });
    const providers = await listProviders(db, await admin(), {});
    expect(providers.map((p) => [p.provider, p.carrierCount])).toEqual([
      ["SHIPSTATION", 2],
      ["BRIDGE_SOURCE", 1],
    ]);
  });

  it("shows a ShipStation key moved from Settings (a bare key) as configured", async () => {
    const { encryptSecret } = await import("../settings/crypto");
    await db.shippingProviderAccount.create({
      data: { provider: "SHIPSTATION", credentialsEnc: encryptSecret("old-key", key) },
    });
    const [shipstation] = await listProviders(db, await admin(), {});
    expect(shipstation?.credentials).toEqual({ apiKey: { configured: true } });
  });
});

describe("setProviderCredentials", () => {
  it("stores the fields as one v1: ciphertext and reports them configured", async () => {
    const account = await setProviderCredentials(db, await admin(), bridge);

    expect(account.credentials).toEqual({
      apiKey: { configured: true },
      customerId: { configured: true },
    });
    const row = await accountRow("BRIDGE_SOURCE");
    expect(row.credentialsEnc).toMatch(/^v1:/);
    expect(JSON.parse(decryptSecret(row.credentialsEnc as string, key))).toEqual(
      bridge.credentials,
    );
  });

  it("never returns or audits a credential value, and audits the field names", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    const responses = [
      await setProviderCredentials(db, actor, shipStation),
      await setProviderCredentials(db, actor, bridge),
      await listProviders(db, actor, adapters),
      await testProvider(db, actor, { provider: "SHIPSTATION" }, adapters),
      await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters),
      await updateProviderConfig(db, actor, {
        provider: "BRIDGE_SOURCE",
        baseUrl: "https://bs.example.com",
      }),
      await clearProviderCredentials(db, actor, { provider: "SHIPSTATION" }),
    ];
    const audit = await db.auditEvent.findMany();

    const everything = JSON.stringify({ responses, audit });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(SECRET.slice(-4));
    expect(audit.map((e) => [e.action, e.after])).toEqual(
      expect.arrayContaining([
        ["secret.set", { provider: "SHIPSTATION", fields: ["apiKey"] }],
        ["secret.set", { provider: "BRIDGE_SOURCE", fields: ["apiKey", "customerId"] }],
        ["secret.clear", { provider: "SHIPSTATION", disabled: true }],
      ]),
    );
  });

  it("forgets the last test result, which was of the old credentials", async () => {
    // Otherwise health reports a cached "ok" for a key nobody has tried.
    const actor = await admin();
    await setProviderCredentials(db, actor, shipStation);
    await testProvider(db, actor, { provider: "SHIPSTATION" }, fakeAdapters().adapters);
    expect((await accountRow("SHIPSTATION")).lastCheckedAt).not.toBeNull();

    await setProviderCredentials(db, actor, {
      provider: "SHIPSTATION",
      credentials: { apiKey: "replacement" },
    });

    expect(await accountRow("SHIPSTATION")).toMatchObject({
      lastCheckedAt: null,
      lastErrorKey: null,
    });
  });

  it("refuses without an encryption key and changes nothing", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", undefined);
    await expect(setProviderCredentials(db, await admin(), shipStation)).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.settings.encryptionKeyMissing",
    });
    expect(
      (await db.shippingProviderAccount.findUnique({ where: { provider: "SHIPSTATION" } }))
        ?.credentialsEnc ?? null,
    ).toBeNull();
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("clearProviderCredentials", () => {
  it("clears the credentials and disables the provider", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await setProviderCredentials(db, actor, shipStation);
    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters);

    const account = await clearProviderCredentials(db, actor, { provider: "SHIPSTATION" });

    expect(account).toMatchObject({
      enabled: false,
      credentials: { apiKey: { configured: false } },
    });
    expect(await accountRow("SHIPSTATION")).toMatchObject({ enabled: false, credentialsEnc: null });
  });

  it("does not audit clearing credentials that aren't set", async () => {
    await clearProviderCredentials(db, await admin(), { provider: "BRIDGE_SOURCE" });
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("updateProviderConfig", () => {
  async function withCredentials(baseUrl: string | null) {
    const actor = await admin();
    if (baseUrl) await updateProviderConfig(db, actor, { provider: "BRIDGE_SOURCE", baseUrl });
    await setProviderCredentials(db, actor, bridge);
    return actor;
  }

  it("clears the credentials and disables when the base URL moves to another origin", async () => {
    const actor = await withCredentials("https://bs.example.com/restapi");
    await db.shippingProviderAccount.update({
      where: { provider: "BRIDGE_SOURCE" },
      data: { enabled: true },
    });

    const result = await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: "https://other.example.com/restapi",
    });

    expect(result).toMatchObject({
      credentialsCleared: true,
      enabled: false,
      config: { baseUrl: "https://other.example.com/restapi" },
      credentials: { apiKey: { configured: false }, customerId: { configured: false } },
    });
    const audit = await db.auditEvent.findMany({ where: { action: "secret.clear" } });
    expect(audit.map((e) => e.after)).toEqual([
      { provider: "BRIDGE_SOURCE", reason: "urlChanged", disabled: true },
    ]);
  });

  it("keeps the credentials when only the path changes", async () => {
    const actor = await withCredentials("https://bs.example.com/a");
    const result = await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: "https://bs.example.com/b",
    });
    expect(result).toMatchObject({
      credentialsCleared: false,
      credentials: { apiKey: { configured: true } },
    });
  });

  it("keeps credentials saved before the first base URL", async () => {
    const actor = await withCredentials(null);
    const result = await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: "https://bs.example.com",
    });
    expect(result.credentialsCleared).toBe(false);
  });

  it("clears the credentials when the base URL is removed, and audits the change", async () => {
    const actor = await withCredentials("https://bs.example.com");
    const result = await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: null,
    });
    expect(result).toMatchObject({ credentialsCleared: true, config: { baseUrl: null } });
    const update = await db.auditEvent.findFirstOrThrow({
      where: { action: "update", entityId: "BRIDGE_SOURCE" },
      orderBy: { at: "desc" },
    });
    expect([update.before, update.after]).toEqual([
      { baseUrl: "https://bs.example.com" },
      { baseUrl: null },
    ]);
  });
});

describe("testProvider", () => {
  it("pings with the saved credentials and records a pass", async () => {
    const actor = await admin();
    const { adapters, pings } = fakeAdapters();
    await setProviderCredentials(db, actor, shipStation);

    const result = await testProvider(db, actor, { provider: "SHIPSTATION" }, adapters);

    expect(pings).toEqual(["SHIPSTATION"]);
    expect(result).toMatchObject({ ok: true, messageKey: null, account: { lastErrorKey: null } });
    expect(result.account.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("returns and records the error key of a failing ping", async () => {
    const actor = await admin();
    await setProviderCredentials(db, actor, {
      provider: "SHIPSTATION",
      credentials: { apiKey: "invalid" },
    });

    const result = await testProvider(
      db,
      actor,
      { provider: "SHIPSTATION" },
      fakeAdapters().adapters,
    );

    expect(result).toMatchObject({ ok: false, messageKey: "errors.shipping.unauthorized" });
    expect(await accountRow("SHIPSTATION")).toMatchObject({
      lastErrorKey: "errors.shipping.unauthorized",
    });
  });

  it("tests a ShipStation key from SHIPSTATION_API_KEY in development", async () => {
    vi.stubEnv("SHIPSTATION_API_KEY", "ss-env");
    const { adapters, pings } = fakeAdapters();
    const result = await testProvider(db, await admin(), { provider: "SHIPSTATION" }, adapters);
    expect(result.ok).toBe(true);
    expect(pings).toEqual(["SHIPSTATION"]);
  });

  it("refuses without credentials or without an adapter", async () => {
    const actor = await admin();
    await expect(
      testProvider(db, actor, { provider: "SHIPSTATION" }, fakeAdapters().adapters),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.carriers.credentialsMissing",
    });

    await setProviderCredentials(db, actor, bridge);
    await expect(
      testProvider(db, actor, { provider: "BRIDGE_SOURCE" }, fakeAdapters("SHIPSTATION").adapters),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.carriers.providerNotAvailable",
    });
  });
});

describe("setProviderEnabled", () => {
  async function expectUnchanged(provider: ProviderId) {
    expect((await accountRow(provider)).enabled).toBe(false);
    expect(await db.auditEvent.count({ where: { action: { in: ["enable", "disable"] } } })).toBe(0);
  }

  it("refuses to enable without credentials and changes nothing", async () => {
    const actor = await admin();
    await listProviders(db, actor, {});
    await expect(
      setProviderEnabled(
        db,
        actor,
        { provider: "SHIPSTATION", enabled: true },
        fakeAdapters().adapters,
      ),
    ).rejects.toMatchObject({ messageKey: "errors.carriers.credentialsMissing" });
    await expectUnchanged("SHIPSTATION");
  });

  it("refuses to enable a provider with no adapter in this build", async () => {
    const actor = await admin();
    await setProviderCredentials(db, actor, bridge);
    await expect(
      setProviderEnabled(
        db,
        actor,
        { provider: "BRIDGE_SOURCE", enabled: true },
        fakeAdapters("SHIPSTATION").adapters,
      ),
    ).rejects.toMatchObject({ messageKey: "errors.carriers.providerNotAvailable" });
    await expectUnchanged("BRIDGE_SOURCE");
  });

  it("refuses to enable when the ping fails, and changes nothing", async () => {
    const actor = await admin();
    await setProviderCredentials(db, actor, {
      provider: "SHIPSTATION",
      credentials: { apiKey: "invalid" },
    });
    await expect(
      setProviderEnabled(
        db,
        actor,
        { provider: "SHIPSTATION", enabled: true },
        fakeAdapters().adapters,
      ),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.carriers.providerUnreachable",
    });
    await expectUnchanged("SHIPSTATION");
  });

  it("enables after a passing ping, and disables without one; both audited", async () => {
    const actor = await admin();
    const { adapters, pings } = fakeAdapters();
    await setProviderCredentials(db, actor, bridge);

    const enabled = await setProviderEnabled(
      db,
      actor,
      { provider: "BRIDGE_SOURCE", enabled: true },
      adapters,
    );
    expect(enabled.enabled).toBe(true);
    expect(pings).toEqual(["BRIDGE_SOURCE"]);

    const disabled = await setProviderEnabled(
      db,
      actor,
      { provider: "BRIDGE_SOURCE", enabled: false },
      {},
    );
    expect(disabled.enabled).toBe(false);
    expect(pings).toEqual(["BRIDGE_SOURCE"]);

    const audit = await db.auditEvent.findMany({
      where: { entityType: "ShippingProviderAccount", action: { in: ["enable", "disable"] } },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => [e.action, e.entityId])).toEqual([
      ["enable", "BRIDGE_SOURCE"],
      ["disable", "BRIDGE_SOURCE"],
    ]);
  });

  it("refuses to enable when the credentials change while it pings, and changes nothing", async () => {
    const actor = await admin();
    await setProviderCredentials(db, actor, shipStation);
    // Another admin saves a different key while this ping is out: it accepted the old one.
    const adapters: AdapterFactories = {
      SHIPSTATION: (credentials) => {
        const provider = createFakeShippingProvider("SHIPSTATION", { credentials });
        const ping = provider.ping.bind(provider);
        provider.ping = async () => {
          await setProviderCredentials(db, actor, {
            provider: "SHIPSTATION",
            credentials: { apiKey: "replaced-meanwhile" },
          });
          return ping();
        };
        return provider;
      },
    };

    await expect(
      setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.conflict" });
    await expectUnchanged("SHIPSTATION");
  });

  it("does not audit a switch to the state it is already in", async () => {
    const actor = await admin();
    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: false }, {});
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("permissions", () => {
  const calls = {
    listProviders: (actor: Parameters<typeof listProviders>[1]) => listProviders(db, actor, {}),
    setProviderCredentials: (actor: Parameters<typeof listProviders>[1]) =>
      setProviderCredentials(db, actor, shipStation),
    clearProviderCredentials: (actor: Parameters<typeof listProviders>[1]) =>
      clearProviderCredentials(db, actor, { provider: "SHIPSTATION" }),
    updateProviderConfig: (actor: Parameters<typeof listProviders>[1]) =>
      updateProviderConfig(db, actor, { provider: "BRIDGE_SOURCE", baseUrl: null }),
    testProvider: (actor: Parameters<typeof listProviders>[1]) =>
      testProvider(db, actor, { provider: "SHIPSTATION" }, fakeAdapters().adapters),
    setProviderEnabled: (actor: Parameters<typeof listProviders>[1]) =>
      setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: false }, {}),
  };

  it.each(Object.keys(calls))("allows an admin to call %s", async (name) => {
    const actor = await admin();
    await setProviderCredentials(db, actor, shipStation);
    await expect(calls[name as keyof typeof calls](actor)).resolves.toBeDefined();
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

describe("shippingProviderHealth", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  const minutesLater = (m: number) => new Date(now.getTime() + m * 60_000);

  it("reports unconfigured, disabled, ok and fail, and degraded only for a failing enabled one", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    expect(await shippingProviderHealth(db, adapters, now)).toEqual({
      providers: { SHIPSTATION: "unconfigured", BRIDGE_SOURCE: "unconfigured" },
      degraded: false,
    });

    await setProviderCredentials(db, actor, shipStation);
    await setProviderCredentials(db, actor, bridge);
    expect((await shippingProviderHealth(db, adapters, now)).providers).toEqual({
      SHIPSTATION: "disabled",
      BRIDGE_SOURCE: "disabled",
    });

    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters);
    expect(await shippingProviderHealth(db, adapters, minutesLater(10))).toEqual({
      providers: { SHIPSTATION: "ok", BRIDGE_SOURCE: "disabled" },
      degraded: false,
    });

    // The key stops working after the provider was enabled.
    const { encryptSecret } = await import("../settings/crypto");
    await db.shippingProviderAccount.update({
      where: { provider: "SHIPSTATION" },
      data: { credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "invalid" }), key) },
    });
    expect(await shippingProviderHealth(db, adapters, minutesLater(20))).toEqual({
      providers: { SHIPSTATION: "fail", BRIDGE_SOURCE: "disabled" },
      degraded: true,
    });
  });

  it("reuses a check from the last 5 minutes instead of pinging again", async () => {
    const actor = await admin();
    const { adapters, pings } = fakeAdapters();
    await setProviderCredentials(db, actor, shipStation);
    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters);
    await db.shippingProviderAccount.update({
      where: { provider: "SHIPSTATION" },
      data: { lastCheckedAt: now, lastErrorKey: null },
    });
    pings.length = 0;

    expect(
      (await shippingProviderHealth(db, adapters, minutesLater(4))).providers.SHIPSTATION,
    ).toBe("ok");
    expect(pings).toEqual([]);

    await shippingProviderHealth(db, adapters, minutesLater(6));
    expect(pings).toEqual(["SHIPSTATION"]);
    expect((await accountRow("SHIPSTATION")).lastCheckedAt).toEqual(minutesLater(6));
  });

  it("reports a ping slower than its bound as a timeout fail, so the health check never hangs", async () => {
    const actor = await admin();
    const { adapters } = fakeAdapters();
    await setProviderCredentials(db, actor, shipStation);
    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters);
    const hanging: AdapterFactories = {
      SHIPSTATION: (credentials) => {
        const provider = createFakeShippingProvider("SHIPSTATION", { credentials });
        provider.ping = () => new Promise(() => {});
        return provider;
      },
    };

    const started = Date.now();
    expect(await shippingProviderHealth(db, hanging, minutesLater(10), 50)).toMatchObject({
      providers: { SHIPSTATION: "fail" },
      degraded: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await accountRow("SHIPSTATION")).lastErrorKey).toBe("errors.shipping.timeout");
  });

  it("pings once for a burst of health checks after the cache expires", async () => {
    // /api/health is public: a burst must not turn into a burst of calls with the store's key.
    const actor = await admin();
    const { adapters, pings } = fakeAdapters();
    await setProviderCredentials(db, actor, shipStation);
    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters);
    pings.length = 0;
    // A real ping takes a while: every check in the burst reads the stale row before it ends.
    const slow: AdapterFactories = {
      SHIPSTATION: (credentials) => {
        const provider = adapters.SHIPSTATION?.(credentials, {}) as ShippingProvider;
        const ping = provider.ping.bind(provider);
        provider.ping = async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return ping();
        };
        return provider;
      },
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => shippingProviderHealth(db, slow, minutesLater(10))),
    );

    expect(pings).toEqual(["SHIPSTATION"]);
    for (const result of results) expect(result.providers.SHIPSTATION).toBe("ok");
  });

  it("reports a cached failing check as fail without pinging again", async () => {
    const actor = await admin();
    const { adapters, pings } = fakeAdapters();
    await setProviderCredentials(db, actor, shipStation);
    await setProviderEnabled(db, actor, { provider: "SHIPSTATION", enabled: true }, adapters);
    await db.shippingProviderAccount.update({
      where: { provider: "SHIPSTATION" },
      data: { lastCheckedAt: now, lastErrorKey: "errors.shipping.unauthorized" },
    });
    pings.length = 0;

    expect(await shippingProviderHealth(db, adapters, minutesLater(1))).toMatchObject({
      providers: { SHIPSTATION: "fail" },
      degraded: true,
    });
    expect(pings).toEqual([]);
  });

  it("reports fail for an enabled provider whose adapter isn't in this build", async () => {
    const actor = await admin();
    await setProviderCredentials(db, actor, bridge);
    await db.shippingProviderAccount.update({
      where: { provider: "BRIDGE_SOURCE" },
      data: { enabled: true },
    });
    expect(await shippingProviderHealth(db, {}, now)).toMatchObject({
      providers: { BRIDGE_SOURCE: "fail" },
      degraded: true,
    });
  });
});
