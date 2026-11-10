import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { AppError } from "../errors";
import type { UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import {
  linkProduct,
  linkProducts,
  lumexiaProducts,
  refreshLumexiaItems,
  runLumexiaRefreshJob,
  searchLumexiaItems,
  setLotOverride,
  suggestLinks,
  unlinkProduct,
} from "./items";
import { needsLot, setLotRules } from "./rules";

// SPEC-lumexia "Lot rules and linking" and success criterion 4: linking products to Lumexia items.

const db: Db = testDb();
afterAll(() => db.$disconnect());

const BASE = "0190a000-0000-7000-8000-0000000000a1";
const RESALE = "0190a000-0000-7000-8000-0000000000a2";
const MADE = "0190a000-0000-7000-8000-0000000000b1";
const STOCKED = "0190a000-0000-7000-8000-0000000000c1";

let fake: FakeLumexiaClient;
let admin: UserActor;
let packer: UserActor;
const connect = () => async () => fake;
const none = async () => null;

let seq = 0;
async function product(fields: { sku?: string | null; name?: string; physical?: boolean } = {}) {
  seq += 1;
  return db.product.create({
    data: {
      wooProductId: 10_000 + seq,
      type: "simple",
      name: fields.name ?? `Product ${seq}`,
      sku: fields.sku === undefined ? `SKU-${seq}` : fields.sku,
      physical: fields.physical ?? true,
      rawPayload: {},
      syncedAt: new Date(),
    },
  });
}

function item(referenceCode: string, fields: { aliases?: string[]; itemTypeId?: string } = {}) {
  return fake.addItem({
    referenceCode,
    name: `Item ${referenceCode}`,
    aliases: fields.aliases ?? [],
    itemTypeId: fields.itemTypeId ?? RESALE,
    procurementTypeId: MADE,
    inventoryTypeId: STOCKED,
  });
}

const audits = (action: string) =>
  db.auditEvent.findMany({ where: { entityType: "Product", action }, orderBy: { at: "asc" } });

beforeEach(async () => {
  await resetDb(db);
  fake = new FakeLumexiaClient();
  fake.addType("item", { id: BASE, name: "Production base" });
  fake.addType("item", { id: RESALE, name: "Resale" });
  admin = await createActor(db, ["ADMIN"]);
  packer = await createActor(db, ["PACKER"]);
});

describe("suggestLinks", () => {
  it("matches SKUs to reference codes and aliases case-insensitively and labels matchedOn", async () => {
    const lavender = await product({ sku: "lav-base-1g", name: "Lavender base" });
    const rose = await product({ sku: "ROSE-8", name: "Rose oil" });
    await product({ sku: "NOTHING" });
    const lav = item("LAV-BASE-1G");
    const roseItem = item("BASE5555", { aliases: ["rose-8", "4411"] });

    const suggestions = await suggestLinks(db, admin, connect());

    expect(suggestions).toEqual([
      {
        productId: lavender.id,
        productName: "Lavender base",
        sku: "lav-base-1g",
        item: expect.objectContaining({ id: lav.id, referenceCode: "LAV-BASE-1G" }),
        matchedOn: "referenceCode",
        matchedValue: "LAV-BASE-1G",
      },
      {
        productId: rose.id,
        productName: "Rose oil",
        sku: "ROSE-8",
        item: expect.objectContaining({ id: roseItem.id }),
        matchedOn: "alias",
        matchedValue: "rose-8",
      },
    ]);
  });

  it("skips SKUs that match more than one item, linked products and products without a SKU", async () => {
    await product({ sku: "TWICE" });
    await product({ sku: null });
    const linked = await product({ sku: "LINKED" });
    item("TWICE");
    item("OTHER", { aliases: ["twice"] });
    const linkedItem = item("LINKED");
    await linkProduct(db, admin, { productId: linked.id, itemId: linkedItem.id }, connect());

    expect(await suggestLinks(db, admin, connect())).toEqual([]);
  });

  it("writes nothing", async () => {
    const p = await product({ sku: "BASE1" });
    item("BASE1");
    await suggestLinks(db, admin, connect());
    const row = await db.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.lumexiaItemId).toBeNull();
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("calls findItems once with every unlinked SKU", async () => {
    await product({ sku: "A" });
    await product({ sku: "B" });
    await suggestLinks(db, admin, connect());
    const calls = fake.calls.filter((c) => c.method === "findItems");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toEqual({ referenceCodes: ["A", "B"] });
  });

  describe("production base SKUs (reference code + pack-size letter)", () => {
    it("links every pack size of a base to the base's item, case-insensitively", async () => {
      const gallon = await product({ sku: "BASE1812G", name: "A gallon" });
      const pail = await product({ sku: "base1812p", name: "B pail" });
      const base = item("BASE1812");

      expect(await suggestLinks(db, admin, connect())).toEqual([
        {
          productId: gallon.id,
          productName: "A gallon",
          sku: "BASE1812G",
          item: expect.objectContaining({ id: base.id, referenceCode: "BASE1812" }),
          matchedOn: "baseCode",
          matchedValue: "BASE1812",
        },
        {
          productId: pail.id,
          productName: "B pail",
          sku: "base1812p",
          item: expect.objectContaining({ id: base.id, referenceCode: "BASE1812" }),
          matchedOn: "baseCode",
          matchedValue: "BASE1812",
        },
      ]);
    });

    it("asks Lumexia for the SKU and its base in the same findItems call", async () => {
      await product({ sku: "BASE1812G" });
      await product({ sku: "BASE1812P" });
      await suggestLinks(db, admin, connect());
      const calls = fake.calls.filter((c) => c.method === "findItems");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0]).toEqual({
        referenceCodes: ["BASE1812G", "BASE1812", "BASE1812P"],
      });
    });

    it("prefers an item matching the whole SKU over the base", async () => {
      await product({ sku: "BASE1812G" });
      const whole = item("BASE1812G");
      item("BASE1812");

      expect(await suggestLinks(db, admin, connect())).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({ id: whole.id }),
          matchedOn: "referenceCode",
        }),
      ]);
    });

    it("doesn't fall back to the base when the whole SKU is ambiguous", async () => {
      await product({ sku: "BASE1812G" });
      item("BASE1812G");
      item("OTHER", { aliases: ["BASE1812G"] });
      item("BASE1812");

      expect(await suggestLinks(db, admin, connect())).toEqual([]);
    });

    it("matches the base on reference codes only, since aliases can hold other systems' ids", async () => {
      await product({ sku: "BASE1812G" });
      item("UNRELATED", { aliases: ["BASE1812"] });

      expect(await suggestLinks(db, admin, connect())).toEqual([]);
    });

    it("strips a letter only from BASE<digits><letter> SKUs", async () => {
      for (const sku of ["FO1812G", "MP-013B", "BASE1812GG", "BASE1812"]) await product({ sku });
      for (const code of ["FO1812", "MP-013", "BASE1812G", "BASE181"]) item(code);

      expect(await suggestLinks(db, admin, connect())).toEqual([]);
    });
  });
});

describe("linkProduct", () => {
  it("stores the item id, reference code, all three type ids and lumexiaSyncedAt, audited", async () => {
    const p = await product();
    const it1 = item("BASE1234", { itemTypeId: BASE });

    const result = await linkProduct(db, admin, { productId: p.id, itemId: it1.id }, connect());

    expect(result).toEqual({
      productId: p.id,
      itemId: it1.id,
      referenceCode: "BASE1234",
      lotOverride: null,
    });
    const row = await db.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({
      lumexiaItemId: it1.id,
      lumexiaItemRef: "BASE1234",
      lumexiaItemTypeId: BASE,
      lumexiaProcurementTypeId: MADE,
      lumexiaInventoryTypeId: STOCKED,
    });
    expect(row.lumexiaSyncedAt).toBeInstanceOf(Date);
    const [audit] = await audits("lumexiaLink");
    expect(audit).toMatchObject({
      entityId: p.id,
      actorId: admin.userId,
      before: { itemId: null, referenceCode: null },
      after: { itemId: it1.id, referenceCode: "BASE1234" },
    });
  });

  it("refuses an item Lumexia doesn't have, and an unknown product", async () => {
    const p = await product();
    await expect(
      linkProduct(db, admin, { productId: p.id, itemId: "nope" }, connect()),
    ).rejects.toMatchObject({ messageKey: "errors.lumexia.itemNotFound" });
    const it1 = item("X");
    await expect(
      linkProduct(
        db,
        admin,
        { productId: "0190a000-0000-7000-8000-000000000999", itemId: it1.id },
        connect(),
      ),
    ).rejects.toMatchObject({ messageKey: "errors.notFound" });
  });

  it("needs a configured client, and maps LumexiaUnavailable to errors.lumexia.unavailable", async () => {
    const p = await product();
    await expect(
      linkProduct(db, admin, { productId: p.id, itemId: "x" }, none),
    ).rejects.toMatchObject({ messageKey: "errors.lumexia.unconfigured" });
    fake.setDown(true);
    const error = await linkProduct(db, admin, { productId: p.id, itemId: "x" }, connect()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ messageKey: "errors.lumexia.unavailable" });
  });
});

describe("linkProducts", () => {
  it("links every confirmed suggestion in one transaction with one findItems call", async () => {
    const a = await product();
    const b = await product();
    const ia = item("A1");
    const ib = item("B1", { itemTypeId: BASE });

    const result = await linkProducts(
      db,
      admin,
      {
        links: [
          { productId: a.id, itemId: ia.id },
          { productId: b.id, itemId: ib.id },
        ],
      },
      connect(),
    );

    expect(result).toEqual({ linked: 2 });
    expect(fake.calls.filter((c) => c.method === "findItems")).toEqual([
      { method: "findItems", args: [{ ids: [ia.id, ib.id] }] },
    ]);
    const rows = await db.product.findMany({ orderBy: { wooProductId: "asc" } });
    expect(rows.map((r) => [r.lumexiaItemRef, r.lumexiaItemTypeId])).toEqual([
      ["A1", RESALE],
      ["B1", BASE],
    ]);
    expect(await audits("lumexiaLink")).toHaveLength(2);
  });

  it("links nothing when one item is missing", async () => {
    const a = await product();
    const b = await product();
    const ia = item("A1");
    await expect(
      linkProducts(
        db,
        admin,
        {
          links: [
            { productId: a.id, itemId: ia.id },
            { productId: b.id, itemId: "gone" },
          ],
        },
        connect(),
      ),
    ).rejects.toMatchObject({ messageKey: "errors.lumexia.itemNotFound" });
    expect(await db.product.count({ where: { lumexiaItemId: { not: null } } })).toBe(0);
  });
});

describe("unlinkProduct", () => {
  it("clears the link and the override, keeps captured lots, audited", async () => {
    const { items } = await createOrder(db, {
      status: "PACKING",
      lines: [{ quantity: 2 }],
      packages: [{ items: [{ line: 0, quantity: 2 }] }],
    });
    const productId = items[0]?.productId as string;
    const it1 = item("BASE1234");
    await linkProduct(db, admin, { productId, itemId: it1.id }, connect());
    await setLotOverride(db, admin, { productId, lotOverride: true });
    const packageItem = await db.packageItem.findFirstOrThrow();
    await db.packageItemLot.create({
      data: {
        packageItemId: packageItem.id,
        lotNumber: "BASE1234.A12A0124",
        quantity: 2,
        position: 0,
      },
    });

    const result = await unlinkProduct(db, admin, { productId });

    expect(result).toEqual({ productId, itemId: null, referenceCode: null, lotOverride: null });
    const row = await db.product.findUniqueOrThrow({ where: { id: productId } });
    expect(row).toMatchObject({
      lumexiaItemId: null,
      lumexiaItemRef: null,
      lumexiaItemTypeId: null,
      lumexiaProcurementTypeId: null,
      lumexiaInventoryTypeId: null,
      lumexiaSyncedAt: null,
      lotOverride: null,
    });
    expect(await db.packageItemLot.count()).toBe(1);
    const [audit] = await audits("lumexiaUnlink");
    expect(audit).toMatchObject({
      before: { itemId: it1.id, referenceCode: "BASE1234", lotOverride: true },
      after: { itemId: null, referenceCode: null, lotOverride: null },
    });
  });

  it("writes no audit row for a product that isn't linked", async () => {
    const p = await product();
    await unlinkProduct(db, admin, { productId: p.id });
    expect(await audits("lumexiaUnlink")).toEqual([]);
  });
});

describe("setLotOverride", () => {
  it("requires a link", async () => {
    const p = await product();
    await expect(
      setLotOverride(db, admin, { productId: p.id, lotOverride: true }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.lumexia.notLinked" });
  });

  it("sets always, never and back to the rules, audited", async () => {
    const p = await product();
    const it1 = item("X1");
    await linkProduct(db, admin, { productId: p.id, itemId: it1.id }, connect());
    await setLotOverride(db, admin, { productId: p.id, lotOverride: false });
    expect(await setLotOverride(db, admin, { productId: p.id, lotOverride: null })).toMatchObject({
      lotOverride: null,
    });
    const rows = await audits("lotOverride");
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [{ lotOverride: null }, { lotOverride: false }],
      [{ lotOverride: false }, { lotOverride: null }],
    ]);
  });
});

describe("lumexiaProducts", () => {
  it("lists every product with its link, item type name and needsLot", async () => {
    await setLotRules(db, admin, {
      itemTypeIds: [BASE],
      procurementTypeIds: [],
      inventoryTypeIds: [],
    });
    const base = await product({ name: "A base" });
    const resale = await product({ name: "B resale" });
    const unlinked = await product({ name: "C unlinked" });
    await linkProduct(
      db,
      admin,
      { productId: base.id, itemId: item("B1", { itemTypeId: BASE }).id },
      connect(),
    );
    await linkProduct(db, admin, { productId: resale.id, itemId: item("R1").id }, connect());
    await setLotOverride(db, admin, { productId: resale.id, lotOverride: true });

    const result = await lumexiaProducts(db, admin, connect());

    expect(result.configured).toBe(true);
    expect(
      result.products.map((p) => [p.id, p.link?.itemTypeName ?? null, p.lotOverride, p.needsLot]),
    ).toEqual([
      [base.id, "Production base", null, true],
      [resale.id, "Resale", true, true],
      [unlinked.id, null, null, false],
    ]);
    expect(result.products[0]?.link).toMatchObject({ referenceCode: "B1", notFound: false });
  });

  it("works without names when Lumexia is down, and says unconfigured without a client", async () => {
    const p = await product();
    await linkProduct(db, admin, { productId: p.id, itemId: item("B1").id }, connect());
    fake.setDown(true);
    const down = await lumexiaProducts(db, admin, connect());
    expect(down.configured).toBe(true);
    expect(down.products[0]?.link).toMatchObject({ referenceCode: "B1", itemTypeName: null });
    expect((await lumexiaProducts(db, admin, none)).configured).toBe(false);
  });
});

describe("searchLumexiaItems", () => {
  it("passes through to searchItems", async () => {
    item("LAV-1");
    item("ROSE-1");
    const found = await searchLumexiaItems(db, admin, { q: "lav" }, connect());
    expect(found.map((i) => i.referenceCode)).toEqual(["LAV-1"]);
  });
});

describe("refreshLumexiaItems", () => {
  it("updates reference codes and type ids, so an item moved to a switched-on type needs a lot", async () => {
    await setLotRules(db, admin, {
      itemTypeIds: [BASE],
      procurementTypeIds: [],
      inventoryTypeIds: [],
    });
    const p = await product();
    const lumexiaItem = item("OLD1");
    await linkProduct(db, admin, { productId: p.id, itemId: lumexiaItem.id }, connect());
    const settings = await loadSettings(db);
    expect(needsLot(await db.product.findUniqueOrThrow({ where: { id: p.id } }), settings)).toBe(
      false,
    );

    // Lumexia moves the item to Production base and renames its code.
    fake = new FakeLumexiaClient();
    fake.addItem({
      id: lumexiaItem.id,
      referenceCode: "NEW1",
      itemTypeId: BASE,
      procurementTypeId: MADE,
      inventoryTypeId: STOCKED,
    });
    const result = await refreshLumexiaItems(db, fake);

    expect(result).toEqual({ checked: 1, updated: 1, notFound: 0 });
    const row = await db.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ lumexiaItemRef: "NEW1", lumexiaItemTypeId: BASE });
    expect(needsLot(row, settings)).toBe(true);
    const [audit] = await audits("lumexiaRefresh");
    expect(audit).toMatchObject({ actorId: null, entityId: p.id });
  });

  it("keeps a missing item's values and marks it not found", async () => {
    const p = await product();
    const lumexiaItem = item("KEEP1", { itemTypeId: BASE });
    await linkProduct(db, admin, { productId: p.id, itemId: lumexiaItem.id }, connect());

    const result = await refreshLumexiaItems(db, new FakeLumexiaClient());

    expect(result).toEqual({ checked: 1, updated: 0, notFound: 1 });
    const row = await db.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({
      lumexiaItemId: lumexiaItem.id,
      lumexiaItemRef: "KEEP1",
      lumexiaItemTypeId: BASE,
    });
    const listed = await lumexiaProducts(db, admin, connect());
    expect(listed.products[0]?.link?.notFound).toBe(true);
  });
});

describe("runLumexiaRefreshJob", () => {
  it("skips while Lumexia isn't configured, and throws an outage so pg-boss retries", async () => {
    const p = await product();
    await linkProduct(db, admin, { productId: p.id, itemId: item("B1").id }, connect());
    expect(await runLumexiaRefreshJob(db, none)).toEqual({ skipped: "unconfigured" });
    fake.setDown(true);
    await expect(runLumexiaRefreshJob(db, connect())).rejects.toMatchObject({
      name: "LumexiaUnavailable",
    });
    fake.setDown(false);
    expect(await runLumexiaRefreshJob(db, connect())).toEqual({
      checked: 1,
      updated: 0,
      notFound: 0,
    });
  });
});

describe("permissions", () => {
  it("lets only admins link, unlink, override, search, suggest and list", async () => {
    const p = await product();
    const forbidden = { kind: "FORBIDDEN" };
    await expect(lumexiaProducts(db, packer, connect())).rejects.toMatchObject(forbidden);
    await expect(searchLumexiaItems(db, packer, { q: "a" }, connect())).rejects.toMatchObject(
      forbidden,
    );
    await expect(suggestLinks(db, packer, connect())).rejects.toMatchObject(forbidden);
    await expect(
      linkProduct(db, packer, { productId: p.id, itemId: "x" }, connect()),
    ).rejects.toMatchObject(forbidden);
    await expect(
      linkProducts(db, packer, { links: [{ productId: p.id, itemId: "x" }] }, connect()),
    ).rejects.toMatchObject(forbidden);
    await expect(unlinkProduct(db, packer, { productId: p.id })).rejects.toMatchObject(forbidden);
    await expect(
      setLotOverride(db, packer, { productId: p.id, lotOverride: true }),
    ).rejects.toMatchObject(forbidden);
    expect(fake.calls).toEqual([]);
  });
});
