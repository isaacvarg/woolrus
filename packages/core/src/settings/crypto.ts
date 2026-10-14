import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Secrets in the settings table are AES-256-GCM encrypted (FR-SET-05). The stored format is
// versioned (`v1:<iv>:<authTag>:<ciphertext>`, base64 parts) so key rotation can be added later.

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A stored secret could not be decrypted: tampered, malformed, or encrypted with another key. */
export class SecretDecryptError extends Error {
  constructor() {
    super("secret could not be decrypted");
    this.name = "SecretDecryptError";
  }
}

/** The key from `SETTINGS_ENCRYPTION_KEY`: strict base64 decoding to exactly 32 bytes, else null. */
export function parseEncryptionKey(value: string | undefined): Buffer | null {
  if (!value || !BASE64.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === KEY_BYTES ? key : null;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map(encode).join(":");
}

/** Throws `SecretDecryptError` rather than ever returning garbage. */
export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = stored.split(":");
  if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new SecretDecryptError();
  }
  if (rest.length > 0 || ![iv, tag, ciphertext].every((part) => BASE64.test(part))) {
    throw new SecretDecryptError();
  }
  const ivBytes = Buffer.from(iv, "base64");
  const tagBytes = Buffer.from(tag, "base64");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) throw new SecretDecryptError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, ivBytes, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretDecryptError();
  }
}

function encode(part: string | Buffer): string {
  return typeof part === "string" ? part : part.toString("base64");
}
