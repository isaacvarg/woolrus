import { randomBytes } from "node:crypto";
import { SecretName } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { decryptSecret } from "./crypto";
import { clearSecret, getPublicSettings, getSettings, setSecret, updateSettings } from "./service";

const db: Db = testDb();
const key = randomBytes(32);
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", key.toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

const SECRET = "cs_live_9f8e7d6c5b4a3210";

describe("settings secrets", () => {
  it.each(SecretName.options)("stores %s in its own column and nowhere else", async (name) => {
    const admin = await createActor(db, ["ADMIN"]);
    const settings = await setSecret(db, admin, { name, value: `v-${name}` });

    const row = await db.settings.findUniqueOrThrow({ where: { id: 1 } });
    for (const other of SecretName.options) {
      const stored = row[`${other}Enc`];
      if (other === name) expect(decryptSecret(stored as string, key)).toBe(`v-${name}`);
      else expect(stored).toBeNull();
      expect(settings.secrets[other]).toEqual({ configured: other === name });
    }
  });

  it("stores only ciphertext and reports the secret as configured", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const settings = await setSecret(db, admin, { name: "wooConsumerSecret", value: SECRET });

    expect(settings.secrets.wooConsumerSecret).toEqual({ configured: true });
    expect(settings.secrets.wooConsumerKey).toEqual({ configured: false });
    const row = await db.settings.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.wooConsumerSecretEnc).toMatch(/^v1:/);
    expect(decryptSecret(row.wooConsumerSecretEnc as string, key)).toBe(SECRET);
  });

  it("never returns or audits the plain value, nor any part of it", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const responses = [
      await setSecret(db, admin, { name: "wooConsumerSecret", value: SECRET }),
      await getSettings(db, admin),
      await getPublicSettings(db, admin),
      await updateSettings(db, admin, { syncIntervalMinutes: 30 }),
      await setSecret(db, admin, { name: "shipstationApiKey", value: `${SECRET}-ss` }),
      await clearSecret(db, admin, { name: "shipstationApiKey" }),
    ];
    const audit = await db.auditEvent.findMany();

    const everything = JSON.stringify({ responses, audit });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(SECRET.slice(-4));
    expect(audit.map((e) => [e.action, e.after])).toEqual(
      expect.arrayContaining([
        ["secret.set", { secret: "wooConsumerSecret" }],
        ["secret.set", { secret: "shipstationApiKey" }],
        ["secret.clear", { secret: "shipstationApiKey" }],
      ]),
    );
  });

  it("clears a secret", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await setSecret(db, admin, { name: "lumexiaApiKey", value: SECRET });
    const settings = await clearSecret(db, admin, { name: "lumexiaApiKey" });

    expect(settings.secrets.lumexiaApiKey).toEqual({ configured: false });
    const row = await db.settings.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.lumexiaApiKeyEnc).toBeNull();
  });

  it("does not audit clearing a secret that isn't set", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await clearSecret(db, admin, { name: "wooWebhookSecret" });
    expect(await db.auditEvent.count()).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-32-byte-key"],
  ])("refuses to store a secret when the key is %s", async (_, value) => {
    const admin = await createActor(db, ["ADMIN"]);
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", value);

    await expect(
      setSecret(db, admin, { name: "wooConsumerKey", value: SECRET }),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.settings.encryptionKeyMissing",
    });
    const row = await db.settings.findUnique({ where: { id: 1 } });
    expect(row?.wooConsumerKeyEnc ?? null).toBeNull();
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("still reads settings without a key, showing stored secrets as configured", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await setSecret(db, admin, { name: "wooConsumerKey", value: SECRET });
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", undefined);

    const settings = await getSettings(db, admin);
    expect(settings.secrets.wooConsumerKey).toEqual({ configured: true });
  });

  it.each([["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"]] as const)(
    "forbids %s from setting or clearing secrets",
    async (role) => {
      const actor = await createActor(db, [role]);
      await expect(
        setSecret(db, actor, { name: "wooConsumerKey", value: SECRET }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await expect(clearSecret(db, actor, { name: "wooConsumerKey" })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    },
  );
});
