import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";

// SPEC-lumexia success criterion 14: the module's migration, against the real database.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

async function packageItemId(): Promise<string> {
  await createOrder(db, {
    status: "PACKING",
    lines: [{ quantity: 3 }],
    packages: [{ items: [{ line: 0, quantity: 3 }] }],
  });
  const item = await db.packageItem.findFirstOrThrow();
  return item.id;
}

describe("the lumexia migration", () => {
  it("refuses a lot row with no units (hand-written CHECK)", async () => {
    const id = await packageItemId();
    const lot = (quantity: number, lotNumber: string) =>
      db.packageItemLot.create({ data: { packageItemId: id, lotNumber, quantity, position: 0 } });

    await expect(lot(0, "BASE1234.A12A0124")).rejects.toThrow(
      /package_item_lots_quantity_positive/,
    );
    await expect(lot(-1, "BASE1234.A12A0124")).rejects.toThrow(
      /package_item_lots_quantity_positive/,
    );
    await expect(lot(3, "BASE1234.A12A0124")).resolves.toMatchObject({
      quantity: 3,
      status: "UNVERIFIED",
    });
  });

  it("deletes a box line's lots with it", async () => {
    const id = await packageItemId();
    await db.packageItemLot.create({
      data: { packageItemId: id, lotNumber: "BASE1234.A12A0124", quantity: 3, position: 0 },
    });
    await db.packageItem.delete({ where: { id } });
    expect(await db.packageItemLot.count()).toBe(0);
  });

  it("keeps one row per lot per box line", async () => {
    const id = await packageItemId();
    const data = { packageItemId: id, lotNumber: "BASE1234.A12A0124", quantity: 1, position: 0 };
    await db.packageItemLot.create({ data });
    await expect(db.packageItemLot.create({ data: { ...data, position: 1 } })).rejects.toThrow();
  });

  it("drops the old PackageItem lot columns", async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'package_items'`;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain("lot_code");
    expect(names).not.toContain("lumexia_lot_id");
  });

  it("leaves the earlier migrations' hand-written constraints in place", async () => {
    const rows = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c'`;
    const names = rows.map((r) => r.conname);
    for (const name of [
      "settings_singleton",
      "order_items_quantity_positive",
      "package_items_quantity_positive",
      "item_voids_quantity_positive",
      "return_items_quantity_positive",
      "packages_weight_positive",
      "package_item_lots_quantity_positive",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("defaults the three lot-rule lists to empty", async () => {
    const settings = await db.settings.create({ data: {} });
    expect(settings).toMatchObject({
      lumexiaLotItemTypeIds: [],
      lumexiaLotProcurementTypeIds: [],
      lumexiaLotInventoryTypeIds: [],
    });
  });
});
