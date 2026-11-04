import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createLabGroup } from "./catalog";
import {
  archiveLabParcel,
  createLabParcel,
  duplicateLabParcel,
  listLabParcelProducts,
  listLabParcels,
  unarchiveLabParcel,
  updateLabParcel,
} from "./parcels";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

let key = 0;
const idempotencyKey = () => `key-${String(++key).padStart(8, "0")}`;
let wooId = 0;

function product(name: string, fields: { sku?: string; physical?: boolean } = {}) {
  return db.product.create({
    data: {
      wooProductId: ++wooId,
      type: "simple",
      name,
      sku: fields.sku ?? null,
      physical: fields.physical ?? true,
      rawPayload: {},
      syncedAt: new Date(),
    },
  });
}

async function setUp() {
  const admin = await createActor(db, ["ADMIN"]);
  const medium = await db.box.create({
    data: {
      name: "Medium",
      lengthIn: 12,
      widthIn: 10,
      heightIn: 8,
      outerLengthIn: 12.5,
      outerWidthIn: 10.5,
      outerHeightIn: 8.5,
    },
  });
  const candle = await product("Glass jar candle", { sku: "CANDLE-1" });
  const rush = await product("Rush order", { physical: false });
  const fragile = await createLabGroup(db, admin, {
    idempotencyKey: idempotencyKey(),
    kind: "PARCEL",
    name: "Fragile",
  });
  return { admin, medium, candle, rush, fragile };
}

const typedSize = { lengthIn: 6, widthIn: 4, heightIn: 2 };
const lock = (id: string) =>
  db.rateLabParcel.update({ where: { id }, data: { lockedAt: new Date() } });

describe("createLabParcel", () => {
  it("copies a box's inner size and keeps the link; a later box edit doesn't change it", async () => {
    const { admin, medium, candle, fragile } = await setUp();
    const parcel = await createLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      title: "Medium box, 3 lb glass jar",
      description: "Dimensional weight on the Medium box",
      size: { boxId: medium.id },
      weightOz: 48,
      items: [{ productId: candle.id, quantity: 1 }],
      groupIds: [fragile.id],
    });
    expect(parcel).toMatchObject({
      title: "Medium box, 3 lb glass jar",
      description: "Dimensional weight on the Medium box",
      box: { id: medium.id, name: "Medium" },
      lengthIn: 12,
      widthIn: 10,
      heightIn: 8,
      weightOz: 48,
      items: [
        { product: { id: candle.id, name: "Glass jar candle", sku: "CANDLE-1" }, quantity: 1 },
      ],
      locked: false,
      archived: false,
      groups: [{ id: fragile.id, name: "Fragile", archived: false }],
      lastQuotedAt: null,
    });

    await db.box.update({ where: { id: medium.id }, data: { lengthIn: 14 } });
    const [listed] = await listLabParcels(db, admin, {});
    expect(listed).toMatchObject({ box: { id: medium.id }, lengthIn: 12 });

    const audit = await db.auditEvent.findMany({ where: { entityId: parcel.id } });
    expect(audit.map((e) => [e.entityType, e.action])).toEqual([["RateLabParcel", "create"]]);
  });

  it("takes a typed size with no box", async () => {
    const { admin } = await setUp();
    const parcel = await createLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      title: "Poly mailer",
      size: typedSize,
      weightOz: 5.5,
    });
    expect(parcel).toMatchObject({ box: null, ...typedSize, weightOz: 5.5, items: [] });
  });

  it("wants a box or all three sides, not both", async () => {
    const { admin, medium } = await setUp();
    const create = (size: object) =>
      createLabParcel(db, admin, {
        idempotencyKey: idempotencyKey(),
        title: "X",
        size,
        weightOz: 1,
      });
    await expect(create({ boxId: medium.id, lengthIn: 3 })).rejects.toThrowError(
      /errors\.rateLab\.boxOrSize/,
    );
    await expect(create({ lengthIn: 3, widthIn: 3 })).rejects.toThrowError(
      /errors\.field\.required/,
    );
  });

  it("refuses an archived or unknown box", async () => {
    const { admin, medium } = await setUp();
    await db.box.update({ where: { id: medium.id }, data: { archivedAt: new Date() } });
    for (const boxId of [medium.id, crypto.randomUUID()]) {
      await expect(
        createLabParcel(db, admin, {
          idempotencyKey: idempotencyKey(),
          title: "X",
          size: { boxId },
          weightOz: 1,
        }),
      ).rejects.toMatchObject({ messageKey: "errors.rateLab.boxInvalid" });
    }
  });

  it("takes physical products only, 1–999 of each, each product once", async () => {
    const { admin, candle, rush } = await setUp();
    const create = (items: { productId: string; quantity: number }[]) =>
      createLabParcel(db, admin, {
        idempotencyKey: idempotencyKey(),
        title: "X",
        size: typedSize,
        weightOz: 1,
        items,
      });
    for (const productId of [rush.id, crypto.randomUUID()]) {
      await expect(create([{ productId, quantity: 1 }])).rejects.toMatchObject({
        messageKey: "errors.rateLab.itemNotPhysical",
      });
    }
    for (const quantity of [0, 1000, 1.5]) {
      await expect(create([{ productId: candle.id, quantity }])).rejects.toThrowError();
    }
    await expect(
      create([
        { productId: candle.id, quantity: 1 },
        { productId: candle.id, quantity: 2 },
      ]),
    ).rejects.toThrowError(/errors\.rateLab\.itemDuplicate/);
    await expect(create([{ productId: candle.id, quantity: 999 }])).resolves.toMatchObject({
      items: [{ quantity: 999 }],
    });
  });

  it("takes parcel groups only", async () => {
    const { admin } = await setUp();
    const west = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "West",
    });
    for (const groupId of [west.id, crypto.randomUUID()]) {
      await expect(
        createLabParcel(db, admin, {
          idempotencyKey: idempotencyKey(),
          title: "X",
          size: typedSize,
          weightOz: 1,
          groupIds: [groupId],
        }),
      ).rejects.toMatchObject({ messageKey: "errors.rateLab.groupInvalid" });
    }
  });

  it("returns the original parcel when a create is replayed", async () => {
    const { admin } = await setUp();
    const input = { idempotencyKey: idempotencyKey(), title: "Once", size: typedSize, weightOz: 2 };
    const first = await createLabParcel(db, admin, input);
    expect(await createLabParcel(db, admin, input)).toEqual(first);
    expect(await db.rateLabParcel.count()).toBe(1);
  });
});

describe("updateLabParcel", () => {
  it("keeps the size copied from its box; picking another box or a typed size replaces it", async () => {
    const { admin, medium } = await setUp();
    const parcel = await createLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      title: "P",
      size: { boxId: medium.id },
      weightOz: 10,
    });
    await db.box.update({ where: { id: medium.id }, data: { lengthIn: 14 } });
    expect(
      await updateLabParcel(db, admin, { id: parcel.id, size: { boxId: medium.id }, weightOz: 11 }),
    ).toMatchObject({ box: { id: medium.id }, lengthIn: 12, weightOz: 11 });

    const large = await db.box.create({
      data: { name: "Large", lengthIn: 18, widthIn: 14, heightIn: 10 },
    });
    expect(
      await updateLabParcel(db, admin, { id: parcel.id, size: { boxId: large.id } }),
    ).toMatchObject({ box: { id: large.id, name: "Large" }, lengthIn: 18, widthIn: 14 });
    expect(await updateLabParcel(db, admin, { id: parcel.id, size: typedSize })).toMatchObject({
      box: null,
      ...typedSize,
    });
  });

  it("replaces the contents", async () => {
    const { admin, candle } = await setUp();
    const mug = await product("Mug");
    const parcel = await createLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      title: "P",
      size: typedSize,
      weightOz: 10,
      items: [{ productId: candle.id, quantity: 1 }],
    });
    const updated = await updateLabParcel(db, admin, {
      id: parcel.id,
      items: [{ productId: mug.id, quantity: 3 }],
    });
    expect(updated.items).toEqual([
      { product: { id: mug.id, name: "Mug", sku: null }, quantity: 3 },
    ]);
    expect(await db.rateLabParcelItem.count()).toBe(1);
    const audit = await db.auditEvent.findMany({ where: { entityId: parcel.id } });
    expect(audit.map((e) => e.action)).toEqual(["create", "update"]);
  });
});

describe("a locked parcel", () => {
  async function locked() {
    const context = await setUp();
    const parcel = await createLabParcel(db, context.admin, {
      idempotencyKey: idempotencyKey(),
      title: "Used",
      size: { boxId: context.medium.id },
      weightOz: 48,
      items: [{ productId: context.candle.id, quantity: 1 }],
    });
    await lock(parcel.id);
    return { ...context, parcel };
  }

  it("refuses size, weight and contents changes", async () => {
    const { admin, parcel, candle } = await locked();
    const changes = [
      { size: typedSize },
      { weightOz: 49 },
      { items: [{ productId: candle.id, quantity: 2 }] },
      { items: [] },
    ];
    for (const change of changes) {
      await expect(updateLabParcel(db, admin, { id: parcel.id, ...change })).rejects.toMatchObject({
        messageKey: "errors.rateLab.parcelLocked",
      });
    }
    expect(await db.rateLabParcel.findUniqueOrThrow({ where: { id: parcel.id } })).toMatchObject({
      boxId: parcel.box?.id,
    });
  });

  it("takes title, description and groups, and the unchanged physical fields", async () => {
    const { admin, parcel, medium, candle, fragile } = await locked();
    await db.box.update({ where: { id: medium.id }, data: { lengthIn: 14 } });
    const updated = await updateLabParcel(db, admin, {
      id: parcel.id,
      title: "Renamed",
      description: "New note",
      groupIds: [fragile.id],
      size: { boxId: medium.id },
      weightOz: 48,
      items: [{ productId: candle.id, quantity: 1 }],
    });
    expect(updated).toMatchObject({
      title: "Renamed",
      description: "New note",
      groups: [{ id: fragile.id }],
      lengthIn: 12,
      locked: true,
    });
  });

  it("duplicates to an unlocked copy titled (copy) with the same box, size, contents and groups", async () => {
    const { admin, parcel, fragile } = await locked();
    await updateLabParcel(db, admin, { id: parcel.id, groupIds: [fragile.id] });
    const copy = await duplicateLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      id: parcel.id,
    });
    expect(copy).toMatchObject({
      title: "Used (copy)",
      box: parcel.box,
      lengthIn: 12,
      weightOz: 48,
      items: parcel.items,
      groups: [{ id: fragile.id }],
      locked: false,
    });
    expect(copy.id).not.toBe(parcel.id);
    const audit = await db.auditEvent.findMany({ where: { entityId: copy.id } });
    expect(audit.map((e) => e.action)).toEqual(["duplicate"]);
  });
});

describe("listing and archiving", () => {
  it("filters by group and title, and hides archived parcels by default", async () => {
    const { admin, fragile } = await setUp();
    const shared = { size: typedSize, weightOz: 1 };
    const jar = await createLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      title: "Jar",
      groupIds: [fragile.id],
      ...shared,
    });
    await createLabParcel(db, admin, { idempotencyKey: idempotencyKey(), title: "Tee", ...shared });
    const titles = async (input: Parameters<typeof listLabParcels>[2]) =>
      (await listLabParcels(db, admin, input)).map((p) => p.title);
    expect(await titles({})).toEqual(["Jar", "Tee"]);
    expect(await titles({ groupIds: [fragile.id] })).toEqual(["Jar"]);
    expect(await titles({ search: "te" })).toEqual(["Tee"]);

    expect(await archiveLabParcel(db, admin, { id: jar.id })).toMatchObject({ archived: true });
    expect(await titles({})).toEqual(["Tee"]);
    expect(await titles({ includeArchived: true })).toEqual(["Jar", "Tee"]);
    expect(await unarchiveLabParcel(db, admin, { id: jar.id })).toMatchObject({ archived: false });
    const audit = await db.auditEvent.findMany({
      where: { entityId: jar.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual(["create", "archive", "unarchive"]);
  });

  it("finds physical products by name or SKU for the contents picker", async () => {
    const { admin, candle } = await setUp();
    await product("Candle wick trimmer", { sku: "TRIM" });
    const names = async (search: string) =>
      (await listLabParcelProducts(db, admin, { search })).map((p) => p.name);
    expect(await names("candle")).toEqual(["Candle wick trimmer", "Glass jar candle"]);
    expect(await names("trim")).toEqual(["Candle wick trimmer"]);
    expect(await names("rush")).toEqual([]);
    expect((await listLabParcelProducts(db, admin, { search: "CANDLE-1" }))[0]?.id).toBe(candle.id);
  });
});

describe("permissions", () => {
  it("allows each procedure to the Rate Lab role", async () => {
    const { medium, candle } = await setUp();
    const lab = await createActor(db, ["PICKER", "RATE_LAB"]);
    const group = await createLabGroup(db, lab, {
      idempotencyKey: idempotencyKey(),
      kind: "PARCEL",
      name: "Mine",
    });
    const parcel = await createLabParcel(db, lab, {
      idempotencyKey: idempotencyKey(),
      title: "Mine",
      size: { boxId: medium.id },
      weightOz: 1,
      items: [{ productId: candle.id, quantity: 1 }],
      groupIds: [group.id],
    });
    expect(await listLabParcels(db, lab, {})).toHaveLength(1);
    expect(await listLabParcelProducts(db, lab, { search: "" })).toHaveLength(1);
    await expect(updateLabParcel(db, lab, { id: parcel.id, title: "B" })).resolves.toBeTruthy();
    await expect(
      duplicateLabParcel(db, lab, { idempotencyKey: idempotencyKey(), id: parcel.id }),
    ).resolves.toBeTruthy();
    await expect(archiveLabParcel(db, lab, { id: parcel.id })).resolves.toBeTruthy();
    await expect(unarchiveLabParcel(db, lab, { id: parcel.id })).resolves.toBeTruthy();
  });

  it("forbids every procedure without the role", async () => {
    const { admin } = await setUp();
    const parcel = await createLabParcel(db, admin, {
      idempotencyKey: idempotencyKey(),
      title: "P",
      size: typedSize,
      weightOz: 1,
    });
    for (const role of ["SHIPPER", "QA"] as const) {
      const other = await createActor(db, [role]);
      const forbidden = [
        () => listLabParcels(db, other, {}),
        () => listLabParcelProducts(db, other, { search: "" }),
        () =>
          createLabParcel(db, other, {
            idempotencyKey: idempotencyKey(),
            title: "No",
            size: typedSize,
            weightOz: 1,
          }),
        () => updateLabParcel(db, other, { id: parcel.id, title: "No" }),
        () => duplicateLabParcel(db, other, { idempotencyKey: idempotencyKey(), id: parcel.id }),
        () => archiveLabParcel(db, other, { id: parcel.id }),
        () => unarchiveLabParcel(db, other, { id: parcel.id }),
      ];
      for (const call of forbidden) await expect(call()).rejects.toThrowError("errors.forbidden");
    }
  });
});
