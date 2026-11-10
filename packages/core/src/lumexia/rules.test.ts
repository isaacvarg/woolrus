import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { AppError } from "../errors";
import type { UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { getLotRules, setLotRules } from "./rules";

// SPEC-lumexia "Lot rules and linking" and success criterion 3: getLotRules / setLotRules.

const db: Db = testDb();
afterAll(() => db.$disconnect());

const BASE = "0190a000-0000-7000-8000-0000000000a1";
const RESALE = "0190a000-0000-7000-8000-0000000000a2";
const MADE = "0190a000-0000-7000-8000-0000000000b1";
const BOUGHT = "0190a000-0000-7000-8000-0000000000b2";
const STOCKED = "0190a000-0000-7000-8000-0000000000c1";
const LOOSE = "0190a000-0000-7000-8000-0000000000c2";
const GONE = "0190a000-0000-7000-8000-0000000000ff";

function world(): FakeLumexiaClient {
  const fake = new FakeLumexiaClient();
  fake.addType("item", { id: BASE, name: "Production base" });
  fake.addType("item", { id: RESALE, name: "Resale" });
  fake.addType("procurement", { id: MADE, name: "Manufactured" });
  fake.addType("procurement", { id: BOUGHT, name: "Purchased" });
  fake.addType("inventory", { id: STOCKED, name: "Stocked", isTracked: true });
  fake.addType("inventory", { id: LOOSE, name: "Loose", isTracked: false });
  return fake;
}
const connect = (client: FakeLumexiaClient | null) => async () => client;

const rules = {
  itemTypeIds: [BASE],
  procurementTypeIds: [],
  inventoryTypeIds: [LOOSE],
};

let admin: UserActor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
});

describe("getLotRules", () => {
  it("lists all three kinds with their switches and isTracked", async () => {
    await setLotRules(db, admin, rules);
    const result = await getLotRules(db, admin, connect(world()));
    expect(result.readOnly).toBe(false);
    expect(result.messageKey).toBeUndefined();
    expect(result.itemTypes).toEqual({
      types: [
        { id: BASE, name: "Production base", needsLot: true },
        { id: RESALE, name: "Resale", needsLot: false },
      ],
      unknownIds: [],
    });
    expect(result.procurementTypes).toEqual({
      types: [
        { id: MADE, name: "Manufactured", needsLot: false },
        { id: BOUGHT, name: "Purchased", needsLot: false },
      ],
      unknownIds: [],
    });
    expect(result.inventoryTypes).toEqual({
      types: [
        { id: STOCKED, name: "Stocked", needsLot: false, isTracked: true },
        { id: LOOSE, name: "Loose", needsLot: true, isTracked: false },
      ],
      unknownIds: [],
    });
  });

  it("reports switched-on ids Lumexia no longer returns", async () => {
    await setLotRules(db, admin, { ...rules, procurementTypeIds: [GONE] });
    const result = await getLotRules(db, admin, connect(world()));
    expect(result.procurementTypes.unknownIds).toEqual([GONE]);
    expect(result.procurementTypes.types.map((t) => t.id)).toEqual([MADE, BOUGHT]);
    expect(result.itemTypes.unknownIds).toEqual([]);
  });

  it("returns the saved ids read-only, without names, when Lumexia is down", async () => {
    await setLotRules(db, admin, rules);
    const fake = world();
    fake.setDown(true);
    const result = await getLotRules(db, admin, connect(fake));
    expect(result).toEqual({
      readOnly: true,
      messageKey: "errors.lumexia.unavailable",
      itemTypes: { types: [{ id: BASE, name: null, needsLot: true }], unknownIds: [] },
      procurementTypes: { types: [], unknownIds: [] },
      inventoryTypes: { types: [{ id: LOOSE, name: null, needsLot: true }], unknownIds: [] },
    });
  });

  it("says why when the key is refused", async () => {
    const fake = world();
    fake.failNext(401);
    const result = await getLotRules(db, admin, connect(fake));
    expect(result).toMatchObject({ readOnly: true, messageKey: "errors.lumexia.unauthorized" });
  });

  it("is read-only when Lumexia isn't configured", async () => {
    await setLotRules(db, admin, rules);
    const result = await getLotRules(db, admin, connect(null));
    expect(result).toMatchObject({
      readOnly: true,
      messageKey: "errors.lumexia.unconfigured",
      itemTypes: { types: [{ id: BASE, name: null, needsLot: true }] },
    });
  });

  it("uses the saved settings by default (unconfigured here)", async () => {
    expect(await getLotRules(db, admin)).toMatchObject({
      readOnly: true,
      messageKey: "errors.lumexia.unconfigured",
    });
  });
});

describe("setLotRules", () => {
  it("replaces the three lists without calling Lumexia", async () => {
    await setLotRules(db, admin, {
      itemTypeIds: [RESALE],
      procurementTypeIds: [MADE],
      inventoryTypeIds: [STOCKED],
    });
    const saved = await setLotRules(db, admin, rules);
    expect(saved).toEqual(rules);
    const row = await loadSettings(db);
    expect(row.lumexiaLotItemTypeIds).toEqual([BASE]);
    expect(row.lumexiaLotProcurementTypeIds).toEqual([]);
    expect(row.lumexiaLotInventoryTypeIds).toEqual([LOOSE]);
  });

  it("accepts ids Lumexia has never returned (works offline)", async () => {
    await setLotRules(db, admin, { ...rules, itemTypeIds: [GONE] });
    expect((await loadSettings(db)).lumexiaLotItemTypeIds).toEqual([GONE]);
  });

  it("drops repeated ids", async () => {
    const saved = await setLotRules(db, admin, { ...rules, itemTypeIds: [BASE, BASE] });
    expect(saved.itemTypeIds).toEqual([BASE]);
  });

  it("writes one audit row with before and after", async () => {
    await setLotRules(db, admin, rules);
    await db.auditEvent.deleteMany();
    await setLotRules(db, admin, { ...rules, procurementTypeIds: [MADE] });
    const audit = await db.auditEvent.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: admin.userId,
      entityType: "Settings",
      action: "lumexiaLotRules",
      before: rules,
      after: { ...rules, procurementTypeIds: [MADE] },
    });
  });

  it("writes nothing when the lists don't change", async () => {
    await setLotRules(db, admin, rules);
    await db.auditEvent.deleteMany();
    await setLotRules(db, admin, { ...rules, itemTypeIds: [BASE] });
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("permissions", () => {
  it("lets admins read and set lot rules", async () => {
    await expect(setLotRules(db, admin, rules)).resolves.toEqual(rules);
    await expect(getLotRules(db, admin, connect(world()))).resolves.toMatchObject({
      readOnly: false,
    });
  });

  it("forbids everyone else (lumexia.manage)", async () => {
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      const actor = await createActor(db, [role]);
      const fake = world();
      for (const call of [
        () => getLotRules(db, actor, connect(fake)),
        () => setLotRules(db, actor, rules),
      ]) {
        const error = await call().catch((e) => e);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ kind: "FORBIDDEN" });
      }
      expect(fake.calls).toEqual([]);
    }
    expect((await loadSettings(db)).lumexiaLotItemTypeIds).toEqual([]);
  });
});
