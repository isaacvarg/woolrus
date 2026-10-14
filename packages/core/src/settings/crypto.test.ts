import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseEncryptionKey, SecretDecryptError } from "./crypto";

const key = randomBytes(32);

/** Flips the first byte of one `v1:<iv>:<tag>:<ciphertext>` part. */
function tamper(stored: string, part: 1 | 2 | 3): string {
  const parts = stored.split(":");
  const bytes = Buffer.from(parts[part] as string, "base64");
  bytes[0] = (bytes[0] as number) ^ 0xff;
  parts[part] = bytes.toString("base64");
  return parts.join(":");
}

describe("secret encryption", () => {
  it("round-trips a value in the versioned format", () => {
    const stored = encryptSecret("cs_live_abc123", key);
    expect(stored).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(stored).not.toContain("cs_live_abc123");
    expect(decryptSecret(stored, key)).toBe("cs_live_abc123");
  });

  it("round-trips an empty value", () => {
    expect(decryptSecret(encryptSecret("", key), key)).toBe("");
  });

  it("uses a fresh IV for every value", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it.each([
    [1, "IV"],
    [2, "auth tag"],
    [3, "ciphertext"],
  ] as const)("rejects a tampered %s (%s)", (part, _name) => {
    expect(() => decryptSecret(tamper(encryptSecret("secret", key), part), key)).toThrow(
      SecretDecryptError,
    );
  });

  it("rejects the wrong key", () => {
    const stored = encryptSecret("secret", key);
    expect(() => decryptSecret(stored, randomBytes(32))).toThrow(SecretDecryptError);
  });

  it.each(["", "secret", "v2:a:b:c", "v1:a:b", "v1:!!:!!:!!"])(
    "rejects malformed input %j",
    (s) => {
      expect(() => decryptSecret(s, key)).toThrow(SecretDecryptError);
    },
  );
});

describe("encryption key", () => {
  it("accepts base64 that decodes to 32 bytes", () => {
    expect(parseEncryptionKey(key.toString("base64"))).toEqual(key);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too short", randomBytes(16).toString("base64")],
    ["too long", randomBytes(33).toString("base64")],
    ["not base64", "not base64 at all, but long enough to be 32 bytes!!!!"],
  ])("rejects a %s key", (_, value) => {
    expect(parseEncryptionKey(value)).toBeNull();
  });
});
