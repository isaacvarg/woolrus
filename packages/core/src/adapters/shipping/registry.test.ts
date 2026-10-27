import { randomBytes } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testDb } from "../../../test/db";
import { encryptSecret, parseEncryptionKey, SecretDecryptError } from "../../settings/crypto";
import { contractShipFrom, contractShipTo } from "./contract";
import { FakeBridgeSourceProvider, FakeShipStationProvider } from "./fake";
import type { ProviderId, ShippingProvider } from "./provider";
import {
  type AdapterFactories,
  buildShippingProvider,
  createShippingProviders,
  fakeShippingProviders,
  shippingAdapterAvailable,
} from "./registry";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let key: Buffer;
beforeEach(async () => {
  await resetDb(db);
  const encoded = randomBytes(32).toString("base64");
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", encoded);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SHIPPING_PROVIDERS", undefined);
  key = parseEncryptionKey(encoded) as Buffer;
});
afterEach(() => vi.unstubAllEnvs());

const shipStationCredentials = { apiKey: "ss-key" };
const bridgeCredentials = { apiKey: "bs-key", customerId: "C-1" };

async function account(
  provider: ProviderId,
  fields: { enabled?: boolean; credentials?: object | null; config?: object } = {},
) {
  const credentials =
    fields.credentials === undefined
      ? provider === "SHIPSTATION"
        ? shipStationCredentials
        : bridgeCredentials
      : fields.credentials;
  await db.shippingProviderAccount.create({
    data: {
      provider,
      enabled: fields.enabled ?? true,
      credentialsEnc: credentials ? encryptSecret(JSON.stringify(credentials), key) : null,
      config: fields.config ?? {},
    },
  });
}

/** Stand-ins for real adapters, recording what each was built with. */
function recordingFactories() {
  const built: { id: ProviderId; credentials: unknown; config: unknown }[] = [];
  const factory =
    (id: ProviderId) =>
    (credentials: unknown, config: unknown): ShippingProvider => {
      built.push({ id, credentials, config });
      return { id } as ShippingProvider;
    };
  const factories = {
    SHIPSTATION: factory("SHIPSTATION"),
    BRIDGE_SOURCE: factory("BRIDGE_SOURCE"),
  } satisfies AdapterFactories;
  return { built, factories };
}

describe("createShippingProviders", () => {
  it("builds one adapter per enabled provider with credentials, ShipStation first", async () => {
    await account("BRIDGE_SOURCE", { config: { baseUrl: "https://bs.example" } });
    await account("SHIPSTATION");
    const { built, factories } = recordingFactories();
    const providers = await createShippingProviders(db, factories);
    expect(providers.map((p) => p.id)).toEqual(["SHIPSTATION", "BRIDGE_SOURCE"]);
    expect(built).toEqual([
      { id: "SHIPSTATION", credentials: shipStationCredentials, config: {} },
      {
        id: "BRIDGE_SOURCE",
        credentials: bridgeCredentials,
        config: { baseUrl: "https://bs.example" },
      },
    ]);
  });

  it("returns nothing for a disabled provider or one without credentials", async () => {
    await account("SHIPSTATION", { enabled: false });
    await account("BRIDGE_SOURCE", { credentials: null });
    const { built, factories } = recordingFactories();
    expect(await createShippingProviders(db, factories)).toEqual([]);
    expect(built).toEqual([]);
  });

  it("returns nothing for credentials that don't fit the provider's schema", async () => {
    await account("BRIDGE_SOURCE", { credentials: { apiKey: "bs-key" } });
    expect(await createShippingProviders(db, recordingFactories().factories)).toEqual([]);
  });

  it("skips a provider with no adapter in this build", async () => {
    await account("SHIPSTATION");
    await account("BRIDGE_SOURCE");
    const { factories } = recordingFactories();
    const providers = await createShippingProviders(db, { SHIPSTATION: factories.SHIPSTATION });
    expect(providers.map((p) => p.id)).toEqual(["SHIPSTATION"]);
  });

  it("throws rather than skipping when credentials can't be decrypted", async () => {
    await account("SHIPSTATION");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await expect(
      createShippingProviders(db, recordingFactories().factories),
    ).rejects.toBeInstanceOf(SecretDecryptError);
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", undefined);
    await expect(createShippingProviders(db, recordingFactories().factories)).rejects.toMatchObject(
      {
        messageKey: "errors.settings.encryptionKeyMissing",
      },
    );
  });

  it("reads the bare ShipStation key the migration copied from Settings as its apiKey", async () => {
    await db.shippingProviderAccount.create({
      data: {
        provider: "SHIPSTATION",
        enabled: true,
        credentialsEnc: encryptSecret("ss-old", key),
      },
    });
    const { built, factories } = recordingFactories();
    await createShippingProviders(db, factories);
    expect(built).toEqual([{ id: "SHIPSTATION", credentials: { apiKey: "ss-old" }, config: {} }]);
  });

  it("fills an unset ShipStation key from SHIPSTATION_API_KEY in development and test", async () => {
    vi.stubEnv("SHIPSTATION_API_KEY", "ss-env");
    await account("SHIPSTATION", { credentials: null });
    await account("BRIDGE_SOURCE", { credentials: null });
    const { built, factories } = recordingFactories();
    await createShippingProviders(db, factories);
    expect(built).toEqual([{ id: "SHIPSTATION", credentials: { apiKey: "ss-env" }, config: {} }]);

    vi.stubEnv("NODE_ENV", "production");
    expect(await createShippingProviders(db, factories)).toEqual([]);
  });

  it("prefers the saved ShipStation key over SHIPSTATION_API_KEY", async () => {
    vi.stubEnv("SHIPSTATION_API_KEY", "ss-env");
    await account("SHIPSTATION");
    const { built, factories } = recordingFactories();
    await createShippingProviders(db, factories);
    expect(built[0]?.credentials).toEqual(shipStationCredentials);
  });

  it("returns the fakes in place of the adapters under SHIPPING_PROVIDERS=fake", async () => {
    vi.stubEnv("SHIPPING_PROVIDERS", "fake");
    await account("SHIPSTATION");
    await account("BRIDGE_SOURCE");
    const { built, factories } = recordingFactories();
    const providers = await createShippingProviders(db, factories);
    expect(providers[0]).toBeInstanceOf(FakeShipStationProvider);
    expect(providers[1]).toBeInstanceOf(FakeBridgeSourceProvider);
    expect(built).toEqual([]);
  });

  it("still leaves out a disabled provider when faking", async () => {
    vi.stubEnv("SHIPPING_PROVIDERS", "fake");
    await account("SHIPSTATION", { enabled: false });
    await account("BRIDGE_SOURCE");
    const providers = await createShippingProviders(db, {});
    expect(providers.map((p) => p.id)).toEqual(["BRIDGE_SOURCE"]);
  });

  it("shares bought fake labels between calls, as between requests", async () => {
    vi.stubEnv("SHIPPING_PROVIDERS", "fake");
    await account("SHIPSTATION");
    const [buyer] = await createShippingProviders(db, {});
    if (!buyer) throw new Error("no provider");
    const shipment = {
      orderNumber: "1",
      shipFrom: contractShipFrom,
      shipTo: contractShipTo,
      residential: true,
      package: { lengthIn: 1, widthIn: 1, heightIn: 1, weightOz: 1 },
      items: [],
      services: [{ carrierExternalId: "se-demo-ground", code: "demo_ground", providerData: {} }],
    };
    const [rate] = await buyer.getRates(shipment);
    if (!rate) throw new Error("no rate");
    const key = `shared-${crypto.randomUUID()}`;
    const label = await buyer.purchaseLabel({
      rate: { ...rate, providerData: {} },
      shipment,
      idempotencyKey: key,
      reference: "1",
      format: "pdf",
      size: "4x6",
    });
    const [finder] = await createShippingProviders(db, {});
    expect((await finder?.findLabel?.(key))?.providerLabelId).toBe(label.providerLabelId);
  });

  it.each(["production", "staging", ""])(
    "gives no fakes when NODE_ENV is %j, falling back to the adapters",
    async (nodeEnv) => {
      vi.stubEnv("SHIPPING_PROVIDERS", "fake");
      vi.stubEnv("NODE_ENV", nodeEnv);
      await account("SHIPSTATION");
      await account("BRIDGE_SOURCE");
      expect(await createShippingProviders(db, {})).toEqual([]);
      const { factories } = recordingFactories();
      const providers = await createShippingProviders(db, factories);
      expect(providers.map((p) => p.id)).toEqual(["SHIPSTATION", "BRIDGE_SOURCE"]);
      for (const p of providers) expect(p).not.toBeInstanceOf(FakeShipStationProvider);
    },
  );
});

describe("fakeShippingProviders", () => {
  it("is on only for SHIPPING_PROVIDERS=fake in development or test", () => {
    for (const [nodeEnv, value, expected] of [
      ["development", "fake", true],
      ["test", "fake", true],
      ["production", "fake", false],
      [undefined, "fake", false],
      ["development", undefined, false],
      ["development", "real", false],
    ] as const) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("SHIPPING_PROVIDERS", value);
      expect(fakeShippingProviders()).toBe(expected);
    }
  });
});

describe("buildShippingProvider", () => {
  it("builds from credentials just entered, so a connection can be tested before saving", () => {
    const { built, factories } = recordingFactories();
    expect(buildShippingProvider("SHIPSTATION", { apiKey: "new" }, {}, factories)?.id).toBe(
      "SHIPSTATION",
    );
    expect(built).toEqual([{ id: "SHIPSTATION", credentials: { apiKey: "new" }, config: {} }]);
    expect(buildShippingProvider("SHIPSTATION", { apiKey: "" }, {}, factories)).toBeNull();
    expect(buildShippingProvider("SHIPSTATION", { apiKey: "new" }, {}, {})).toBeNull();
  });

  it("says which providers have an adapter in this build", () => {
    expect(shippingAdapterAvailable("SHIPSTATION", {})).toBe(false);
    expect(shippingAdapterAvailable("SHIPSTATION", recordingFactories().factories)).toBe(true);
    vi.stubEnv("SHIPPING_PROVIDERS", "fake");
    expect(shippingAdapterAvailable("BRIDGE_SOURCE", {})).toBe(true);
  });
});
