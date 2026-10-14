import { randomBytes } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { SecretDecryptError } from "./crypto";
import { getIntegrationConfig } from "./integration";
import { setSecret, updateSettings } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());

/** Every env var the dev fallback reads, so tests never depend on the developer's .env. */
const fallbackEnv = {
  WOO_URL: "http://localhost:8090",
  WOO_CONSUMER_KEY: "ck_env",
  WOO_CONSUMER_SECRET: "cs_env",
  WOO_WEBHOOK_SECRET: "wh_env",
  SHIPSTATION_API_KEY: "ss_env",
  LUMEXIA_BASE_URL: "http://lumexia.localhost",
  LUMEXIA_API_KEY: "lx_env",
};

function stubEnv(nodeEnv: string, vars: Partial<typeof fallbackEnv> = {}) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  for (const name of Object.keys(fallbackEnv)) {
    vi.stubEnv(name, vars[name as keyof typeof fallbackEnv]);
  }
}

beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

async function configureWooInSettings() {
  const admin = await createActor(db, ["ADMIN"]);
  await updateSettings(db, admin, { wooStoreUrl: "https://shop.example.com" });
  await setSecret(db, admin, { name: "wooConsumerKey", value: "ck_settings" });
  await setSecret(db, admin, { name: "wooConsumerSecret", value: "cs_settings" });
  return admin;
}

describe("getIntegrationConfig", () => {
  it("builds every integration from Settings alone in production, each from its own values", async () => {
    stubEnv("production", fallbackEnv);
    const admin = await configureWooInSettings();
    await updateSettings(db, admin, { lumexiaBaseUrl: "https://lumexia.example.com" });
    await setSecret(db, admin, { name: "wooWebhookSecret", value: "wh_settings" });
    await setSecret(db, admin, { name: "shipstationApiKey", value: "ss_settings" });
    await setSecret(db, admin, { name: "lumexiaApiKey", value: "lx_settings" });

    expect(await getIntegrationConfig(db)).toEqual({
      woocommerce: {
        url: "https://shop.example.com",
        consumerKey: "ck_settings",
        consumerSecret: "cs_settings",
        webhookSecret: "wh_settings",
      },
      shipstation: { apiKey: "ss_settings" },
      lumexia: { baseUrl: "https://lumexia.example.com", apiKey: "lx_settings" },
    });
  });

  it("returns decrypted values from Settings", async () => {
    stubEnv("production");
    await configureWooInSettings();

    expect(await getIntegrationConfig(db)).toEqual({
      woocommerce: {
        url: "https://shop.example.com",
        consumerKey: "ck_settings",
        consumerSecret: "cs_settings",
        webhookSecret: null,
      },
      shipstation: null,
      lumexia: null,
    });
  });

  it("ignores env vars in production", async () => {
    stubEnv("production", fallbackEnv);
    expect(await getIntegrationConfig(db)).toEqual({
      woocommerce: null,
      shipstation: null,
      lumexia: null,
    });
  });

  it("fills unset values from env vars in development", async () => {
    stubEnv("development", fallbackEnv);
    expect(await getIntegrationConfig(db)).toEqual({
      woocommerce: {
        url: "http://localhost:8090",
        consumerKey: "ck_env",
        consumerSecret: "cs_env",
        webhookSecret: "wh_env",
      },
      shipstation: { apiKey: "ss_env" },
      lumexia: { baseUrl: "http://lumexia.localhost", apiKey: "lx_env" },
    });
  });

  it("prefers values stored in Settings over env vars in development", async () => {
    stubEnv("development", fallbackEnv);
    await configureWooInSettings();
    expect((await getIntegrationConfig(db)).woocommerce).toEqual({
      url: "https://shop.example.com",
      consumerKey: "ck_settings",
      consumerSecret: "cs_settings",
      webhookSecret: "wh_env",
    });
  });

  it("is null for an integration missing a required part", async () => {
    stubEnv("production");
    const admin = await createActor(db, ["ADMIN"]);
    await setSecret(db, admin, { name: "wooConsumerKey", value: "ck_settings" });
    await updateSettings(db, admin, { lumexiaBaseUrl: "https://lumexia.example.com" });
    expect(await getIntegrationConfig(db)).toMatchObject({ woocommerce: null, lumexia: null });
  });

  it("fails loudly when a stored secret can't be decrypted", async () => {
    stubEnv("development", fallbackEnv);
    await configureWooInSettings();
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await expect(getIntegrationConfig(db)).rejects.toThrow(SecretDecryptError);
  });

  it("fails loudly when secrets are stored but the key is missing", async () => {
    stubEnv("development", fallbackEnv);
    await configureWooInSettings();
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", undefined);
    await expect(getIntegrationConfig(db)).rejects.toMatchObject({
      messageKey: "errors.settings.encryptionKeyMissing",
    });
  });
});
