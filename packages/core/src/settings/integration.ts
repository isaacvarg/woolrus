import type { Db, Settings } from "@woolrus/db";
import { AppError } from "../errors";
import { decryptSecret } from "./crypto";
import { encryptionKey, integrationEnvFallback } from "./env";

export type IntegrationConfig = {
  woocommerce: {
    url: string;
    consumerKey: string;
    consumerSecret: string;
    webhookSecret: string | null;
  } | null;
  shipstation: { apiKey: string } | null;
  lumexia: { baseUrl: string; apiKey: string } | null;
};

/**
 * Decrypted integration settings for adapters. Server-internal: deliberately not in the API
 * contract (NFR-SEC-03). An integration is null until its required parts are all set.
 * Throws rather than falling back when a stored secret can't be decrypted, so a wrong key is
 * noticed instead of silently using other credentials.
 */
export async function getIntegrationConfig(db: Db): Promise<IntegrationConfig> {
  const row = await db.settings.findUnique({ where: { id: 1 } });
  const env = integrationEnvFallback();

  const decrypt = (stored: string | null | undefined): string | null => {
    if (!stored) return null;
    const key = encryptionKey();
    if (!key) throw new AppError("BAD_REQUEST", "errors.settings.encryptionKeyMissing");
    return decryptSecret(stored, key);
  };
  const secret = (column: keyof Settings & `${string}Enc`, fallback: string | null | undefined) =>
    decrypt(row?.[column]) ?? fallback ?? null;

  const wooUrl = row?.wooStoreUrl ?? env?.wooUrl ?? null;
  const consumerKey = secret("wooConsumerKeyEnc", env?.wooConsumerKey);
  const consumerSecret = secret("wooConsumerSecretEnc", env?.wooConsumerSecret);
  const webhookSecret = secret("wooWebhookSecretEnc", env?.wooWebhookSecret);
  const shipstationApiKey = secret("shipstationApiKeyEnc", env?.shipstationApiKey);
  const lumexiaBaseUrl = row?.lumexiaBaseUrl ?? env?.lumexiaBaseUrl ?? null;
  const lumexiaApiKey = secret("lumexiaApiKeyEnc", env?.lumexiaApiKey);

  return {
    woocommerce:
      wooUrl && consumerKey && consumerSecret
        ? { url: wooUrl, consumerKey, consumerSecret, webhookSecret }
        : null,
    shipstation: shipstationApiKey ? { apiKey: shipstationApiKey } : null,
    lumexia:
      lumexiaBaseUrl && lumexiaApiKey ? { baseUrl: lumexiaBaseUrl, apiKey: lumexiaApiKey } : null,
  };
}
