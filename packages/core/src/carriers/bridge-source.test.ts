import { randomBytes } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import services from "../adapters/shipping/bridge-source/__fixtures__/services.json" with {
  type: "json",
};
import { BridgeSourceAdapter } from "../adapters/shipping/bridge-source/adapter";
import type { AdapterFactories } from "../adapters/shipping/registry";
import { listShippingConfig, setCarrierEnabled, setServiceEnabled, syncCarriers } from "./carriers";
import {
  listProviders,
  setProviderCredentials,
  setProviderEnabled,
  updateProviderConfig,
} from "./providers";

// The real Bridge Source adapter behind the carriers service, against a played-back HTTP layer.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SHIPPING_PROVIDERS", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const KEY = "TEST_bridge_key_8a1f";
const bridge = {
  provider: "BRIDGE_SOURCE",
  credentials: { apiKey: KEY, customerId: "TEST-CUSTOMER-9" },
} as const;

function adapters(status = 200) {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(status === 200 ? services : { error: "x" }), { status });
  };
  const factories: AdapterFactories = {
    BRIDGE_SOURCE: (credentials, config) => new BridgeSourceAdapter(credentials, config, { fetch }),
  };
  return { factories, calls: () => calls };
}

const admin = () => createActor(db, ["ADMIN"]);

async function configured(actor: Awaited<ReturnType<typeof admin>>) {
  await updateProviderConfig(db, actor, {
    provider: "BRIDGE_SOURCE",
    baseUrl: "https://bridge.test",
  });
  await setProviderCredentials(db, actor, bridge);
}

describe("Bridge Source behind the carriers service", () => {
  it("is available in this build", async () => {
    const [, account] = await listProviders(db, await admin());
    expect(account).toMatchObject({ provider: "BRIDGE_SOURCE", adapterAvailable: true });
  });

  it("enables with credentials, a base URL and a passing ping", async () => {
    const actor = await admin();
    const { factories } = adapters();
    await configured(actor);
    const account = await setProviderEnabled(
      db,
      actor,
      { provider: "BRIDGE_SOURCE", enabled: true },
      factories,
    );
    expect(account.enabled).toBe(true);
  });

  it("refuses to enable without a base URL, changing nothing and making no request", async () => {
    const actor = await admin();
    const { factories, calls } = adapters();
    await setProviderCredentials(db, actor, bridge);
    await expect(
      setProviderEnabled(db, actor, { provider: "BRIDGE_SOURCE", enabled: true }, factories),
    ).rejects.toMatchObject({ messageKey: "errors.carriers.providerUnreachable" });
    expect(calls()).toBe(0);
    expect(
      (await db.shippingProviderAccount.findUniqueOrThrow({ where: { provider: "BRIDGE_SOURCE" } }))
        .enabled,
    ).toBe(false);
  });

  it("refuses to enable without credentials", async () => {
    const actor = await admin();
    const { factories } = adapters();
    await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: "https://bridge.test",
    });
    await expect(
      setProviderEnabled(db, actor, { provider: "BRIDGE_SOURCE", enabled: true }, factories),
    ).rejects.toMatchObject({ messageKey: "errors.carriers.credentialsMissing" });
  });

  it.each([401, 500])(
    "refuses to enable when the ping answers %s, changing nothing",
    async (status) => {
      const actor = await admin();
      const { factories } = adapters(status);
      await configured(actor);
      await expect(
        setProviderEnabled(db, actor, { provider: "BRIDGE_SOURCE", enabled: true }, factories),
      ).rejects.toMatchObject({ messageKey: "errors.carriers.providerUnreachable" });
      expect(
        (
          await db.shippingProviderAccount.findUniqueOrThrow({
            where: { provider: "BRIDGE_SOURCE" },
          })
        ).enabled,
      ).toBe(false);
    },
  );

  it("syncs carriers and services disabled, and keeps the switches on a re-sync", async () => {
    const actor = await admin();
    const { factories } = adapters();
    await configured(actor);
    await setProviderEnabled(db, actor, { provider: "BRIDGE_SOURCE", enabled: true }, factories);

    const first = await syncCarriers(db, actor, { provider: "BRIDGE_SOURCE" }, factories);
    expect(first).toMatchObject({ carriersAdded: 2, servicesAdded: 4 });
    let config = await listShippingConfig(db, actor);
    const carriers = config.find((c) => c.provider === "BRIDGE_SOURCE")?.carriers ?? [];
    expect(carriers.map((c) => c.name)).toEqual(["Carrier A", "Carrier B"]);
    expect(carriers.every((c) => !c.enabled && c.services.every((s) => !s.enabled))).toBe(true);
    const ground = carriers[0]?.services.find((s) => s.code === "A_GROUND");
    expect(ground).toMatchObject({ domestic: true, international: false });

    await setCarrierEnabled(db, actor, { id: carriers[0]?.id as string, enabled: true });
    await setServiceEnabled(db, actor, { id: ground?.id as string, enabled: true });
    await syncCarriers(db, actor, { provider: "BRIDGE_SOURCE" }, factories);
    config = await listShippingConfig(db, actor);
    const again = config
      .find((c) => c.provider === "BRIDGE_SOURCE")
      ?.carriers.find((c) => c.name === "Carrier A");
    expect(again?.enabled).toBe(true);
    expect(again?.services.find((s) => s.code === "A_GROUND")?.enabled).toBe(true);
    expect(again?.services.find((s) => s.code === "A_EXPRESS_INTL")?.enabled).toBe(false);

    const stored = await db.carrierService.findFirstOrThrow({ where: { code: "A_GROUND" } });
    expect(stored.providerData).toMatchObject({ packageTypeCode: "A_CUSTOM" });
  });

  it("clears the credentials on an origin change of the base URL, not on a path change", async () => {
    const actor = await admin();
    await configured(actor);
    await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: "https://bridge.test/v2",
    });
    let [, account] = await listProviders(db, actor);
    expect(account?.credentials.apiKey?.configured).toBe(true);
    await updateProviderConfig(db, actor, {
      provider: "BRIDGE_SOURCE",
      baseUrl: "https://other.test",
    });
    [, account] = await listProviders(db, actor);
    expect(account?.credentials.apiKey?.configured).toBe(false);
  });

  it("keeps the key out of responses and audit rows", async () => {
    const actor = await admin();
    const { factories } = adapters();
    await configured(actor);
    await setProviderEnabled(db, actor, { provider: "BRIDGE_SOURCE", enabled: true }, factories);
    await syncCarriers(db, actor, { provider: "BRIDGE_SOURCE" }, factories);
    const seen = JSON.stringify([
      await listProviders(db, actor, factories),
      await listShippingConfig(db, actor),
      await db.auditEvent.findMany(),
    ]);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(bridge.credentials.customerId);
  });
});
