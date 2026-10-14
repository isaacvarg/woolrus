import { parseEncryptionKey } from "./crypto";

// The only place core reads settings-related environment variables. Read on every call (no
// caching) so tests can stub them and a fixed key takes effect without a code change.

/** The secret-encryption key, or null when `SETTINGS_ENCRYPTION_KEY` is missing or malformed. */
export function encryptionKey(): Buffer | null {
  return parseEncryptionKey(process.env.SETTINGS_ENCRYPTION_KEY);
}
