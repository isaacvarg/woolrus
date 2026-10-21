import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { getPublicSettings, getSettings, setSecret, updateSettings } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const address = {
  name: "Shipping Dept",
  phone: "555-123-4567",
  address1: "1 Warehouse Way",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US" as const,
};

const nonAdmins = [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"]] as const;

describe("settings service", () => {
  it("creates the settings row with defaults on first read", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    expect(await db.settings.count()).toBe(0);

    expect(await getSettings(db, admin)).toEqual({
      shipFromAddress: null,
      wooStoreUrl: null,
      lumexiaBaseUrl: null,
      emailFrom: null,
      syncIntervalMinutes: 5,
      stationIdleLockMinutes: 10,
      claimExpiryMinutes: 30,
      pickBatchMaxOrders: 10,
      stageSlaMinutes: {},
      weightDisplay: "LB_OZ",
      piiRetentionDays: null,
      qaMustDifferFromPacker: false,
      secrets: {
        wooConsumerKey: { configured: false },
        wooConsumerSecret: { configured: false },
        wooWebhookSecret: { configured: false },
        shipstationApiKey: { configured: false },
        lumexiaApiKey: { configured: false },
        resendApiKey: { configured: false },
      },
    });
    expect(await db.settings.count()).toBe(1);
  });

  it("changes only the patched fields and audits them with before and after", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await getSettings(db, admin);

    const updated = await updateSettings(db, admin, {
      shipFromAddress: address,
      syncIntervalMinutes: 15,
      weightDisplay: "LB_OZ", // unchanged: not audited
    });

    expect(updated).toMatchObject({
      shipFromAddress: address,
      syncIntervalMinutes: 15,
      stationIdleLockMinutes: 10,
      weightDisplay: "LB_OZ",
    });
    const audit = await db.auditEvent.findMany({ where: { entityType: "Settings" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: admin.userId, action: "update" });
    // Exactly the changed fields: the unchanged weightDisplay must not appear.
    expect(audit[0]?.before).toEqual({ shipFromAddress: null, syncIntervalMinutes: 5 });
    expect(audit[0]?.after).toEqual({ shipFromAddress: address, syncIntervalMinutes: 15 });
  });

  it("saves and clears the email sender, audited like any setting", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const from = "Woolrus <no-reply@example.com>";
    expect((await updateSettings(db, admin, { emailFrom: from })).emailFrom).toBe(from);
    expect((await updateSettings(db, admin, { emailFrom: null })).emailFrom).toBeNull();

    const audit = await db.auditEvent.findMany({
      where: { entityType: "Settings" },
      orderBy: { id: "asc" },
    });
    expect(audit.map((a) => [a.before, a.after])).toEqual([
      [{ emailFrom: null }, { emailFrom: from }],
      [{ emailFrom: from }, { emailFrom: null }],
    ]);
  });

  it("leaves every field a patch omits as it was, not back at its default", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const earlier = await updateSettings(db, admin, {
      shipFromAddress: address,
      wooStoreUrl: "https://shop.example.com",
      lumexiaBaseUrl: "https://lumexia.example.com",
      stationIdleLockMinutes: 20,
      claimExpiryMinutes: 45,
      pickBatchMaxOrders: 6,
      stageSlaMinutes: { QA: 30 },
      weightDisplay: "LB_DECIMAL",
      piiRetentionDays: 90,
      qaMustDifferFromPacker: true,
    });

    const updated = await updateSettings(db, admin, { syncIntervalMinutes: 15 });

    const { clearedSecrets, ...settings } = earlier;
    const expected = { ...settings, syncIntervalMinutes: 15 };
    expect(updated).toEqual({ ...expected, clearedSecrets });
    expect(await getSettings(db, admin)).toEqual(expected);
  });

  it("writes no audit event when nothing changes", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await updateSettings(db, admin, {});
    await updateSettings(db, admin, { syncIntervalMinutes: 5 });
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("clears nullable fields with null", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await updateSettings(db, admin, {
      wooStoreUrl: "https://shop.example.com",
      piiRetentionDays: 90,
    });
    const cleared = await updateSettings(db, admin, { wooStoreUrl: null, piiRetentionDays: null });
    expect(cleared).toMatchObject({ wooStoreUrl: null, piiRetentionDays: null });
  });

  it("treats stored JSON that no longer fits the contract as unset", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await db.settings.create({
      data: { id: 1, shipFromAddress: { street: "old shape" }, stageSlaMinutes: { PENDING: "x" } },
    });
    expect(await getSettings(db, admin)).toMatchObject({
      shipFromAddress: null,
      stageSlaMinutes: {},
    });
  });

  it("gives every role the public settings", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await updateSettings(db, admin, { weightDisplay: "LB_DECIMAL", stageSlaMinutes: { QA: 30 } });

    for (const roles of [["ADMIN"], ...nonAdmins] as const) {
      const actor = await createActor(db, roles);
      expect(await getPublicSettings(db, actor)).toEqual({
        weightDisplay: "LB_DECIMAL",
        stationIdleLockMinutes: 10,
        claimExpiryMinutes: 30,
        pickBatchMaxOrders: 10,
        stageSlaMinutes: { QA: 30 },
      });
    }
  });

  it.each(nonAdmins)("forbids %s from reading or updating admin settings", async (role) => {
    const actor = await createActor(db, [role]);
    await expect(getSettings(db, actor)).rejects.toMatchObject({
      kind: "FORBIDDEN",
      messageKey: "errors.forbidden",
    });
    await expect(updateSettings(db, actor, { syncIntervalMinutes: 30 })).rejects.toMatchObject({
      kind: "FORBIDDEN",
      messageKey: "errors.forbidden",
    });
    expect(await db.auditEvent.count()).toBe(0);
  });
});

// Changing where an integration points must not send its saved keys to the new place
// (SPEC-store-sync "Settings follow-up", SC 11).
describe("integration URL origin changes", () => {
  beforeEach(() => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  });
  afterEach(() => vi.unstubAllEnvs());

  const wooSecrets = ["wooConsumerKey", "wooConsumerSecret", "wooWebhookSecret"] as const;

  async function withWooSecrets(url: string | null) {
    const admin = await createActor(db, ["ADMIN"]);
    if (url) await updateSettings(db, admin, { wooStoreUrl: url });
    for (const name of [...wooSecrets, "lumexiaApiKey", "shipstationApiKey"] as const) {
      await setSecret(db, admin, { name, value: `value-of-${name}` });
    }
    return admin;
  }

  /** One transaction's audit rows share a timestamp, so they come back in secret-name order. */
  const clearAudits = async () =>
    (await db.auditEvent.findMany({ where: { action: "secret.clear" } })).sort((a, b) =>
      JSON.stringify(a.after).localeCompare(JSON.stringify(b.after)),
    );

  it.each([
    ["host", "https://other.example.com"],
    ["scheme", "http://shop.localhost"],
    ["port", "https://shop.example.com:8443"],
  ])("a %s change clears the WooCommerce secrets, audited", async (_what, next) => {
    const start = next.startsWith("http:") ? "https://shop.localhost" : "https://shop.example.com";
    const admin = await withWooSecrets(start);

    const result = await updateSettings(db, admin, { wooStoreUrl: next });

    expect(result.clearedSecrets).toEqual([...wooSecrets]);
    expect(result.wooStoreUrl).toBe(next);
    for (const name of wooSecrets) expect(result.secrets[name]).toEqual({ configured: false });
    // Other integrations keep theirs.
    expect(result.secrets.lumexiaApiKey).toEqual({ configured: true });
    expect(result.secrets.shipstationApiKey).toEqual({ configured: true });
    const audits = await clearAudits();
    expect(audits.map((a) => a.after)).toEqual(
      wooSecrets.map((secret) => ({ secret, reason: "urlChanged" })),
    );
    expect(audits.every((a) => a.actorId === admin.userId)).toBe(true);
  });

  it("a path-only change keeps the secrets", async () => {
    const admin = await withWooSecrets("https://shop.example.com");
    const result = await updateSettings(db, admin, {
      wooStoreUrl: "https://shop.example.com/store",
    });
    expect(result.clearedSecrets).toEqual([]);
    for (const name of wooSecrets) expect(result.secrets[name]).toEqual({ configured: true });
    expect(await clearAudits()).toHaveLength(0);
  });

  it("keeps secrets saved before the first URL, and clears them when the URL is removed", async () => {
    const admin = await withWooSecrets(null);
    const first = await updateSettings(db, admin, { wooStoreUrl: "https://shop.example.com" });
    expect(first.clearedSecrets).toEqual([]);
    expect(first.secrets.wooConsumerKey).toEqual({ configured: true });

    const removed = await updateSettings(db, admin, { wooStoreUrl: null });
    expect(removed.clearedSecrets).toEqual([...wooSecrets]);
    expect(removed.secrets.wooConsumerKey).toEqual({ configured: false });
  });

  it("reports nothing cleared when no secret was set", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await updateSettings(db, admin, { wooStoreUrl: "https://shop.example.com" });
    const result = await updateSettings(db, admin, { wooStoreUrl: "https://other.example.com" });
    expect(result.clearedSecrets).toEqual([]);
    expect(await clearAudits()).toHaveLength(0);
  });

  it("does the same for Lumexia, leaving WooCommerce alone", async () => {
    const admin = await withWooSecrets("https://shop.example.com");
    await updateSettings(db, admin, { lumexiaBaseUrl: "https://lumexia.example.com/api" });

    const path = await updateSettings(db, admin, {
      lumexiaBaseUrl: "https://lumexia.example.com/v2",
    });
    expect(path.clearedSecrets).toEqual([]);

    const host = await updateSettings(db, admin, { lumexiaBaseUrl: "https://lx.example.net" });
    expect(host.clearedSecrets).toEqual(["lumexiaApiKey"]);
    expect(host.secrets.lumexiaApiKey).toEqual({ configured: false });
    expect(host.secrets.wooConsumerKey).toEqual({ configured: true });
    expect((await clearAudits()).map((a) => a.after)).toEqual([
      { secret: "lumexiaApiKey", reason: "urlChanged" },
    ]);
  });
});
