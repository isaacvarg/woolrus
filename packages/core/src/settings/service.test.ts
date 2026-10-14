import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { getPublicSettings, getSettings, updateSettings } from "./service";

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
      syncIntervalMinutes: 5,
      stationIdleLockMinutes: 10,
      stageSlaMinutes: {},
      weightDisplay: "LB_OZ",
      piiRetentionDays: null,
      qaMustDifferFromPacker: false,
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
    expect(audit[0]).toMatchObject({
      actorId: admin.userId,
      action: "update",
      before: { shipFromAddress: null, syncIntervalMinutes: 5 },
      after: { shipFromAddress: address, syncIntervalMinutes: 15 },
    });
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
