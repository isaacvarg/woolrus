import type { Db } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fullActivity } from "../../test/activity";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { removeLot, scanLot, setLotQuantity } from "../lumexia/lots";
import { validateLots } from "../lumexia/validate";
import {
  addPackage,
  deletePackage,
  packRemaining,
  packUnits,
  scanIntoPackage,
  setPackageBox,
  setWeight,
  unpackUnits,
} from "../packing/service";
import { loadSettings } from "../settings/service";
import { actionMessageKey, actionRegistry } from "./actions";

// SPEC-order-activity "Action registry" for Packing (#200): packages, units, weights, box scans
// and lots at packing, each in the timeline with wording that names the box and line.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const BASE_TYPE = "0190a000-0000-7000-8000-0000000000b1";
const ITEM = "0190a000-0000-7000-8000-00000000a001";
const LOT = "BASE1234.A12A0124";
const key = () => crypto.randomUUID();

/** A Packing order with a lot-needing soap (3) and a plain towel (2, scannable as TOWEL-1). */
async function packing() {
  const packer = await createActor(db, ["PACKER"]);
  await db.user.update({ where: { id: packer.userId }, data: { name: "Maria" } });
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: packer.userId,
    claimedAt: new Date(),
    lines: [
      { quantity: 3, pickStatus: "PICKED", name: "Lavender soap" },
      { quantity: 2, pickStatus: "PICKED", name: "Towel", sku: "TOWEL-1" },
    ],
  });
  await db.product.update({
    where: { id: built.items[0]?.productId as string },
    data: { lumexiaItemId: ITEM, lumexiaItemRef: "BASE1234", lumexiaItemTypeId: BASE_TYPE },
  });
  const settings = await loadSettings(db);
  await db.settings.update({
    where: { id: settings.id },
    data: { lumexiaLotItemTypeIds: [BASE_TYPE] },
  });
  const box = await db.box.create({
    data: { name: "Small", lengthIn: 8, widthIn: 6, heightIn: 4, maxWeightOz: 32 },
  });
  const soap = built.items[0] as { id: string };
  const towel = built.items[1] as { id: string };
  return { packer, order: built.order, box, soap, towel };
}

const message = (locale: "en" | "es", action: string) =>
  (messages[locale].activity.action as Record<string, string | undefined>)[
    actionMessageKey(action).slice("activity.action.".length)
  ];

describe("packing and lots in the timeline", () => {
  it.each(["en", "es"] as const)("words every Packing action in %s", (locale) => {
    const missing = Object.entries(actionRegistry)
      .filter(([, spec]) => spec.category === "packing")
      .map(([action]) => action)
      .filter((action) => !message(locale, action));
    expect(missing).toEqual([]);
  });

  it("finds each packing and lot write in the order's activity, naming the box and line", async () => {
    const { packer, order, box, soap } = await packing();

    const first = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = first.packages[0]?.id as string;
    await packUnits(db, packer, { packageId: pkg, orderItemId: soap.id, quantity: 3 });
    await scanIntoPackage(db, packer, { packageId: pkg, code: "TOWEL-1", scanId: key() });
    await setWeight(db, packer, { packageId: pkg, weightOz: 34, overrideReason: "Dense soap" });
    await scanLot(db, packer, { packageId: pkg, code: LOT, scanId: key() });

    const lot = await db.packageItemLot.findFirstOrThrow({ where: { lotNumber: LOT } });
    const fake = new FakeLumexiaClient();
    fake.addItem({ id: ITEM, referenceCode: "BASE1234", itemTypeId: BASE_TYPE });
    fake.addLot({ itemId: ITEM, lotNumber: LOT });
    await validateLots(db, fake, [lot.id]);

    // Every row carries the order.
    const rows = await db.auditEvent.findMany({
      where: { action: { startsWith: "package." } },
      select: { orderId: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orderId === order.id)).toBe(true);
    expect(
      await db.auditEvent.count({ where: { action: { startsWith: "lot." }, orderId: null } }),
    ).toBe(0);

    const { entries } = await fullActivity(db, packer, { id: order.id });
    const find = (action: string) => entries.find((e) => e.action === action);

    expect(find("package.add")).toMatchObject({
      category: "packing",
      actor: { name: "Maria" },
      target: { kind: "box", number: 1 },
      params: { box: 1 },
    });
    expect(find("package.packUnits")).toMatchObject({
      target: { kind: "box", number: 1 },
      params: { box: 1, line: "Lavender soap", count: 3 },
    });
    expect(find("package.scan")).toMatchObject({ params: { box: 1, line: "Towel", count: 1 } });
    const weight = find("package.setWeight");
    expect(weight).toMatchObject({ params: { box: 1, weightOz: 34 } });
    // Not weighed before; after: the weight and the overweight reason.
    expect(weight?.details?.before).not.toHaveProperty("weightOz");
    expect(weight?.details?.after).toMatchObject({ weightOz: 34, overrideReason: "Dense soap" });
    expect(find("lot.scan")).toMatchObject({
      category: "packing",
      target: { kind: "box", number: 1 },
      params: { box: 1, line: "Lavender soap", lot: LOT },
    });
    expect(find("lot.validate")).toMatchObject({
      category: "packing",
      actor: null,
      system: "lumexia",
      params: { box: 1, line: "Lavender soap", lot: LOT, status: "VALID" },
    });
  });

  it("words box changes, unpacking, pack the rest, lot edits and a removed box", async () => {
    const { packer, order, box, soap, towel } = await packing();
    const add = () =>
      addPackage(db, packer, { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() });

    const one = (await add()).packages[0]?.id as string;
    await packUnits(db, packer, { packageId: one, orderItemId: soap.id, quantity: 3 });
    await setPackageBox(db, packer, {
      packageId: one,
      box: { lengthIn: 10, widthIn: 8, heightIn: 6 },
    });
    await scanLot(db, packer, { packageId: one, code: LOT, scanId: key() });
    await scanLot(db, packer, { packageId: one, code: "BASE1234.B07C1124", scanId: key() });
    const second = await db.packageItemLot.findFirstOrThrow({
      where: { lotNumber: "BASE1234.B07C1124" },
    });
    await setLotQuantity(db, packer, { lotId: second.id, quantity: 2 });
    const first = await db.packageItemLot.findFirstOrThrow({ where: { lotNumber: LOT } });
    await removeLot(db, packer, { lotId: first.id });

    const two = (await add()).packages[1]?.id as string;
    await packRemaining(db, packer, { packageId: two });
    await unpackUnits(db, packer, { packageId: two, orderItemId: towel.id, quantity: 1 });
    await unpackUnits(db, packer, { packageId: two, orderItemId: towel.id, quantity: 1 });
    await deletePackage(db, packer, { packageId: two });

    // The removed box's rows keep the order after the package is gone.
    expect(await db.package.count({ where: { id: two } })).toBe(0);
    const removed = await db.auditEvent.findFirstOrThrow({ where: { action: "package.delete" } });
    expect(removed.orderId).toBe(order.id);

    const { entries } = await fullActivity(db, packer, { id: order.id });
    const find = (action: string) => entries.find((e) => e.action === action);

    expect(find("package.delete")).toMatchObject({
      target: { kind: "box", number: 2 },
      params: { box: 2 },
    });
    expect(find("package.packRemaining")).toMatchObject({ params: { box: 2, count: 2 } });
    expect(find("package.setBox")).toMatchObject({ params: { box: 1 } });
    // Two one-unit unpacks by one person on one box group into one entry.
    expect(find("package.unpackUnits")).toMatchObject({
      count: 2,
      params: { box: 2, line: "Towel", count: 1 },
    });
    expect(find("lot.setQuantity")).toMatchObject({
      params: { box: 1, line: "Lavender soap", lot: "BASE1234.B07C1124", quantity: 2 },
    });
    expect(find("lot.remove")).toMatchObject({
      params: { box: 1, line: "Lavender soap", lot: LOT },
    });
  });
});
