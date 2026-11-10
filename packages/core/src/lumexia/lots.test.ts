import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { completePack } from "../packing/complete";
import { getPackView } from "../packing/queries";
import { packRemaining, packUnits, scanIntoPackage, unpackUnits } from "../packing/service";
import type { UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { scanLot } from "./lots";
import { setLotRules } from "./rules";

// SPEC-lumexia "Capturing lots" and the packed gate's lotMissing: success criteria 3, 5–8.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const BASE_TYPE = "0190a000-0000-7000-8000-0000000000b1";
const key = () => crypto.randomUUID();

/** Switches the item type on (or off) in the lot rules. */
async function lotRules(on: boolean) {
  const row = await loadSettings(db);
  await db.settings.update({
    where: { id: row.id },
    data: { lumexiaLotItemTypeIds: on ? [BASE_TYPE] : [] },
  });
}

/** Links line `index`'s product to Lumexia item `ref`, of the switched-on item type. */
async function link(productId: string | null, ref: string) {
  await db.product.update({
    where: { id: productId as string },
    data: { lumexiaItemId: `item-${ref}`, lumexiaItemRef: ref, lumexiaItemTypeId: BASE_TYPE },
  });
}

/**
 * A Packing order claimed by a fresh packer, with one package holding every unit, boxed and
 * weighed. Line 0 is BASE1234 (needs a lot); others aren't linked.
 */
async function packing(lines: LineSpec[] = [{ quantity: 3 }], { rules = true } = {}) {
  const packer = await createActor(db, ["PACKER"]);
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: packer.userId,
    lines: lines.map((l, i) => ({ pickStatus: "PICKED" as const, name: `Line ${i}`, ...l })),
    packages: [
      {
        items: lines.map((l, i) => ({ line: i, quantity: l.quantity ?? 1 })),
        weightOz: 40,
      },
    ],
  });
  await link(built.items[0]?.productId ?? null, "BASE1234");
  await lotRules(rules);
  const pkg = built.packages[0] as { id: string };
  const boxLine = await db.packageItem.findFirstOrThrow({
    where: { packageId: pkg.id, orderItemId: built.items[0]?.id },
  });
  return { packer, ...built, pkg, boxLine };
}

const scan = (actor: UserActor, packageId: string, code: string, scanId = key()) =>
  scanLot(db, actor, { packageId, code, scanId });

/** "A12A0124:2 B07C1124:1", the box line's lots in position order. */
async function lotsOf(packageItemId: string) {
  const rows = await db.packageItemLot.findMany({
    where: { packageItemId },
    orderBy: { position: "asc" },
  });
  return rows.map((r) => `${r.lotNumber?.split(".")[1]}:${r.quantity}`).join(" ");
}

const A = "BASE1234.A12A0124";
const B = "BASE1234.B07C1124";
const C = "BASE1234.C01D0125";

describe("scanLot: the split rule", () => {
  it("gives the first lot every unit, saved unverified, audited and in the pack view", async () => {
    const { packer, order, pkg, boxLine } = await packing();

    const result = await scan(packer, pkg.id, " base1234.a12a0124 ");

    expect(await lotsOf(boxLine.id)).toBe("A12A0124:3");
    const row = await db.packageItemLot.findFirstOrThrow({ where: { packageItemId: boxLine.id } });
    expect(row).toMatchObject({ status: "UNVERIFIED", scannedById: packer.userId, position: 0 });
    expect(result.packages[0]?.items[0]).toMatchObject({
      needsLot: true,
      lots: [{ lotNumber: A, quantity: 3, status: "UNVERIFIED", isDefault: true }],
    });
    const audit = await db.auditEvent.findMany({ where: { action: "lot.scan" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityType: "PackageItem",
      entityId: boxLine.id,
      actorId: packer.userId,
    });
    // Lots don't touch the order's version, rates or the package's weight.
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(3);
    expect((await db.package.findUniqueOrThrow({ where: { id: pkg.id } })).weightStale).toBe(false);
  });

  it("splits one unit at a time and refuses once every unit has a lot", async () => {
    const { packer, pkg, boxLine } = await packing();

    await scan(packer, pkg.id, A);
    await scan(packer, pkg.id, B);
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 B07C1124:1");
    await scan(packer, pkg.id, B);
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:2");
    // The default has 1 left: C takes from the largest lot, B.
    await scan(packer, pkg.id, C);
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:1 C01D0125:1");

    await expect(scan(packer, pkg.id, "BASE1234.D01D0125")).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.lumexia.allUnitsHaveLots",
      params: { count: 3 },
    });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:1 C01D0125:1");
  });

  it("is idempotent on scanId", async () => {
    const { packer, pkg, boxLine } = await packing();
    await scan(packer, pkg.id, A);
    const scanId = key();

    await scan(packer, pkg.id, B, scanId);
    await scan(packer, pkg.id, B, scanId);

    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 B07C1124:1");
    expect(await db.auditEvent.count({ where: { action: "lot.scan" } })).toBe(2);
  });

  it("picks the line of the lot's item when the package holds several", async () => {
    const { packer, pkg, items } = await packing([{ quantity: 2 }, { quantity: 1 }]);
    await link(items[1]?.productId ?? null, "CAP9");
    const capLine = await db.packageItem.findFirstOrThrow({
      where: { packageId: pkg.id, orderItemId: items[1]?.id },
    });

    await scan(packer, pkg.id, "CAP9.A01A0124");

    expect(await lotsOf(capLine.id)).toBe("A01A0124:1");
  });
});

describe("scanLot: refusals", () => {
  it("refuses a lot for another item, saves nothing on the line, and notes it once", async () => {
    const { packer, order, pkg, boxLine } = await packing();
    const scanId = key();
    const wrong = "BASE9999.A12A0124";

    const refused = scan(packer, pkg.id, wrong, scanId);
    await expect(refused).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.lumexia.lotWrongItem",
      params: { lotNumber: wrong, itemRef: "BASE9999" },
    });
    // The same scan retried writes no second note.
    await expect(scan(packer, pkg.id, wrong, scanId)).rejects.toMatchObject({
      messageKey: "errors.lumexia.lotWrongItem",
    });

    expect(await db.packageItemLot.count({ where: { packageItemId: boxLine.id } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: "lot.scan" } })).toBe(0);
    const notes = await db.note.findMany({ where: { orderId: order.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      packageId: pkg.id,
      visibility: "INTERNAL",
      authorId: packer.userId,
      content:
        "Lot BASE9999.A12A0124 (item BASE9999) was scanned for Line 0 and rejected: it belongs to a different item.",
    });
  });

  it("refuses a package with nothing that needs a lot", async () => {
    const { packer, pkg } = await packing([{ quantity: 3 }], { rules: false });
    await expect(scan(packer, pkg.id, A)).rejects.toMatchObject({
      messageKey: "errors.lumexia.lotNotOnPackage",
    });
  });

  it("refuses what isn't a lot, and a QR code for now", async () => {
    const { packer, pkg } = await packing();
    await expect(scan(packer, pkg.id, "LAV-8OZ")).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.lumexia.notALot",
    });
    await expect(scan(packer, pkg.id, crypto.randomUUID())).rejects.toMatchObject({
      messageKey: "errors.lumexia.scanLotNumber",
    });
  });

  it("needs order.pack and the live claim", async () => {
    const { pkg } = await packing();
    const picker = await createActor(db, ["PICKER"]);
    const otherPacker = await createActor(db, ["PACKER"]);

    await expect(scan(picker, pkg.id, A)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(scan(otherPacker, pkg.id, A)).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    expect(await db.packageItemLot.count()).toBe(0);
  });
});

describe("packing keeps a box line's lots covering its units", () => {
  it("packUnits, scanIntoPackage and packRemaining add to the default lot", async () => {
    const { packer, pkg, items, boxLine } = await packing([{ quantity: 2, barcode: "0042" }]);
    await db.orderItem.update({ where: { id: items[0]?.id }, data: { quantity: 6 } });
    await db.orderItem.update({ where: { id: items[0]?.id }, data: { pickedQuantity: 6 } });
    await scan(packer, pkg.id, A);
    await scan(packer, pkg.id, B);

    await packUnits(db, packer, { packageId: pkg.id, orderItemId: items[0]?.id as string });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 B07C1124:1");
    await scanIntoPackage(db, packer, { packageId: pkg.id, code: "0042", scanId: key() });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:3 B07C1124:1");
    await packRemaining(db, packer, { packageId: pkg.id });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:5 B07C1124:1");
  });

  it("unpackUnits takes from the default down to 1, then the latest lot", async () => {
    const { packer, pkg, items, boxLine } = await packing([{ quantity: 5 }]);
    for (const code of [A, B, C, C]) await scan(packer, pkg.id, code);
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 B07C1124:1 C01D0125:2");
    const orderItemId = items[0]?.id as string;

    await unpackUnits(db, packer, { packageId: pkg.id, orderItemId, quantity: 2 });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:1 C01D0125:1");
    await unpackUnits(db, packer, { packageId: pkg.id, orderItemId });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:1");
    await unpackUnits(db, packer, { packageId: pkg.id, orderItemId, quantity: 2 });
    expect(await db.packageItemLot.count()).toBe(0);
  });

  it("random scans, packs and unpacks never break Σ lots = the box line", async () => {
    const { packer, pkg, items } = await packing([{ quantity: 2 }]);
    const orderItemId = items[0]?.id as string;
    await db.orderItem.update({
      where: { id: orderItemId },
      data: { quantity: 6, pickedQuantity: 6 },
    });
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const codes = [A, B, C];
    for (let step = 0; step < 30; step++) {
      const op = random(3);
      const attempt =
        op === 0
          ? scan(packer, pkg.id, codes[random(3)] as string)
          : op === 1
            ? packUnits(db, packer, { packageId: pkg.id, orderItemId })
            : unpackUnits(db, packer, { packageId: pkg.id, orderItemId });
      await attempt.catch(() => undefined); // refusals (nothing to pack, all units have lots) are fine
      const line = await db.packageItem.findFirst({
        where: { packageId: pkg.id, orderItemId },
        include: { lots: true },
      });
      const total = line?.lots.reduce((sum, l) => sum + l.quantity, 0) ?? 0;
      expect(total).toBeLessThanOrEqual(line?.quantity ?? 0);
      if (line && line.lots.length > 0) expect(total, `step ${step}`).toBe(line.quantity);
    }
  });
});

describe("the packed gate's lotMissing", () => {
  it("blocks completing until every lot-needing box line has a lot", async () => {
    const { packer, order, pkg } = await packing([{ quantity: 2 }, { quantity: 1 }]);
    const complete = () =>
      completePack(db, packer, { orderId: order.id, expectedVersion: 3, after: "queue" });

    await expect(complete()).rejects.toMatchObject({
      kind: "CONFLICT",
      unmet: [{ messageKey: "errors.workflow.gate.lotMissing", params: { line: "Line 0" } }],
    });
    const view = await getPackView(db, packer, { orderId: order.id });
    expect(view.unmet).toEqual([
      { messageKey: "errors.workflow.gate.lotMissing", params: { line: "Line 0", package: 1 } },
    ]);
    expect(view.packages[0]?.items.map((it) => it.needsLot)).toEqual([true, false]);

    // An unverified lot is enough.
    await scan(packer, pkg.id, A);
    await expect(complete()).resolves.toEqual({ nextOrderId: null });
  });

  it("switching a type on makes an order already in Packing need lots", async () => {
    const { packer, order } = await packing([{ quantity: 2 }], { rules: false });
    expect((await getPackView(db, packer, { orderId: order.id })).unmet).toEqual([]);

    const admin = await createActor(db, ["ADMIN"]);
    await setLotRules(db, admin, {
      itemTypeIds: [BASE_TYPE],
      procurementTypeIds: [],
      inventoryTypeIds: [],
    });

    const view = await getPackView(db, packer, { orderId: order.id });
    expect(view.unmet.map((u) => u.messageKey)).toEqual(["errors.workflow.gate.lotMissing"]);
    expect(view.packages[0]?.items[0]?.needsLot).toBe(true);
  });
});
