import { createHash, randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

// Station credentials (SPEC-identity "PIN rules", decision 5). Only hashes are stored: a database
// read can't reveal a PIN or make a badge.

const SCRYPT = { N: 16_384, r: 8, p: 1 } satisfies ScryptOptions;
const KEY_LENGTH = 32;

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_LENGTH, SCRYPT, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** `scrypt$<salt>$<key>` (base64), with a fresh salt per hash. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await derive(pin, salt)).toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(pin, Buffer.from(salt, "base64"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Crockford base32: no I, L, O or U, so a code read off the printed badge can't be misread.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `WRB-` + 20 Crockford base32 characters (100 random bits). Fits QR's alphanumeric mode. */
export function newBadgeCode(): string {
  // 256 is a multiple of 32, so masking each byte keeps every character equally likely.
  return `WRB-${[...randomBytes(20)].map((byte) => CROCKFORD[byte & 31]).join("")}`;
}

/** What `User.badgeCode` holds. Case-insensitive, as scanners and people type either. */
export function hashBadgeCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
