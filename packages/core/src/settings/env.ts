import { parseEncryptionKey } from "./crypto";

// The only place core reads settings-related environment variables. Read on every call (no
// caching) so tests can stub them and a fixed key takes effect without a code change.

/** The secret-encryption key, or null when `SETTINGS_ENCRYPTION_KEY` is missing or malformed. */
export function encryptionKey(): Buffer | null {
  return parseEncryptionKey(process.env.SETTINGS_ENCRYPTION_KEY);
}

/** Env vars that stand in for unset integration settings, outside production only. */
export type IntegrationEnv = {
  wooUrl: string | null;
  wooConsumerKey: string | null;
  wooConsumerSecret: string | null;
  wooWebhookSecret: string | null;
  /** Fills an unset ShipStation provider account (adapters/shipping/credentials.ts). */
  shipstationApiKey: string | null;
  lumexiaBaseUrl: string | null;
  lumexiaApiKey: string | null;
};

/**
 * Keeps the zero-config dev stack working. Fails closed: only an explicit development or test
 * environment uses it, so production (or a run with NODE_ENV unset) has Settings as the only
 * source (decisions in SPEC-settings.md).
 */
export function integrationEnvFallback(): IntegrationEnv | null {
  const env = process.env.NODE_ENV;
  if (env !== "development" && env !== "test") return null;
  const read = (name: string) => process.env[name] || null;
  return {
    wooUrl: read("WOO_URL"),
    wooConsumerKey: read("WOO_CONSUMER_KEY"),
    wooConsumerSecret: read("WOO_CONSUMER_SECRET"),
    wooWebhookSecret: read("WOO_WEBHOOK_SECRET"),
    shipstationApiKey: read("SHIPSTATION_API_KEY"),
    lumexiaBaseUrl: read("LUMEXIA_BASE_URL"),
    lumexiaApiKey: read("LUMEXIA_API_KEY"),
  };
}
