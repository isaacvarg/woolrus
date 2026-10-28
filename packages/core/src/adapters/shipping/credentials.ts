import { AppError } from "../../errors";
import { decryptSecret, encryptSecret } from "../../settings/crypto";
import { encryptionKey, integrationEnvFallback } from "../../settings/env";
import type { ProviderId } from "./provider";

// How a provider account's credentials are stored: one encrypted JSON blob of its fields.

function requireKey(): Buffer {
  const key = encryptionKey();
  if (!key) throw new AppError("BAD_REQUEST", "errors.settings.encryptionKeyMissing");
  return key;
}

export function encryptProviderCredentials(credentials: Record<string, string>): string {
  return encryptSecret(JSON.stringify(credentials), requireKey());
}

/**
 * The account's credentials, not yet checked against the provider's schema, or null when it has
 * none. A ShipStation key moved from Settings by migration is the bare key, not JSON. An unset
 * ShipStation key falls back to `SHIPSTATION_API_KEY` in development and test only. Throws rather
 * than returning null when stored credentials can't be decrypted, so a wrong key is noticed.
 */
export function readProviderCredentials(id: ProviderId, credentialsEnc: string | null): unknown {
  if (credentialsEnc) {
    const text = decryptSecret(credentialsEnc, requireKey());
    const parsed = parseJson(text);
    return typeof parsed === "object" && parsed !== null ? parsed : { apiKey: text };
  }
  if (id === "SHIPSTATION") {
    const apiKey = integrationEnvFallback()?.shipstationApiKey;
    if (apiKey) return { apiKey };
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
