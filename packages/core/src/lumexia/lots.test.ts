import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { voidItem } from "../exceptions/voids";
import { completePack } from "../packing/complete";
import { getPackView } from "../packing/queries";
import { packRemaining, packUnits, scanIntoPackage, unpackUnits } from "../packing/service";
import type { UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { removeLot, scanLot, setLotQuantity } from "./lots";
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

  it("refuses what isn't a lot", async () => {
    const { packer, pkg } = await packing();
    await expect(scan(packer, pkg.id, "LAV-8OZ")).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.lumexia.notALot",
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

  it("a void that shrinks a box line takes the units out of its lots too", async () => {
    const { packer, pkg, items, order, boxLine } = await packing([{ quantity: 3 }]);
    for (const code of [A, B, B]) await scan(packer, pkg.id, code);
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:2");

    await voidItem(db, packer, {
      orderId: order.id,
      orderItemId: items[0]?.id as string,
      quantity: 1,
      reason: "Damaged",
    });

    expect((await db.packageItem.findUniqueOrThrow({ where: { id: boxLine.id } })).quantity).toBe(
      2,
    );
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:1");
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

/** Scans with `lumexia` as the configured client (null = unconfigured). */
const scanWith = (
  lumexia: FakeLumexiaClient | null,
  actor: UserActor,
  input: { packageId: string; code: string; packageItemId?: string },
  scanId = key(),
) => scanLot(db, actor, { ...input, scanId }, { connect: async () => lumexia });

/** A fake Lumexia that knows `item-BASE1234` and `item-OTHER`, each with one lot. */
function lumexiaWithLots() {
  const lumexia = new FakeLumexiaClient();
  const ours = lumexia.addLot({ itemId: "item-BASE1234", lotNumber: "base1234.a12a0124" });
  const theirs = lumexia.addLot({ itemId: "item-OTHER", lotNumber: "OTHER9.B01B0125" });
  return { lumexia, ours, theirs };
}

describe("scanLot: QR codes (the lot's UUID)", () => {
  it("resolves the lot and its item through Lumexia, with a 2 s budget", async () => {
    const { packer, pkg, items } = await packing([{ quantity: 1 }, { quantity: 3 }]);
    await link(items[0]?.productId ?? null, "CAP9");
    await link(items[1]?.productId ?? null, "BASE1234");
    const target = await db.packageItem.findFirstOrThrow({
      where: { packageId: pkg.id, orderItemId: items[1]?.id },
    });
    const { lumexia, ours } = lumexiaWithLots();

    await scanWith(lumexia, packer, { packageId: pkg.id, code: ours.id.toUpperCase() });

    const rows = await db.packageItemLot.findMany({ where: { packageItemId: target.id } });
    expect(rows).toMatchObject([
      { lotNumber: A, lumexiaLotId: ours.id, quantity: 3, status: "UNVERIFIED" },
    ]);
    expect(lumexia.calls).toEqual([{ method: "getLot", args: [ours.id] }]);
  });

  it("treats a lot's QR code and its printed number as one lot", async () => {
    const { packer, pkg, boxLine } = await packing();
    const { lumexia, ours } = lumexiaWithLots();

    await scan(packer, pkg.id, B);
    await scanWith(lumexia, packer, { packageId: pkg.id, code: ours.id });
    await scan(packer, pkg.id, A);
    expect(await lotsOf(boxLine.id)).toBe("B07C1124:1 A12A0124:2");
  });

  it("refuses a lot on another item with one note, and saves nothing", async () => {
    const { packer, order, pkg, boxLine } = await packing();
    const { lumexia, theirs } = lumexiaWithLots();
    const scanId = key();

    for (let i = 0; i < 2; i++) {
      await expect(
        scanWith(lumexia, packer, { packageId: pkg.id, code: theirs.id }, scanId),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.lumexia.lotWrongItem",
        params: { lotNumber: "OTHER9.B01B0125", itemRef: "OTHER9" },
      });
    }

    expect(await db.packageItemLot.count({ where: { packageItemId: boxLine.id } })).toBe(0);
    const notes = await db.note.findMany({ where: { orderId: order.id } });
    expect(notes.map((n) => n.content)).toEqual([
      "Lot OTHER9.B01B0125 (item OTHER9) was scanned for Line 0 and rejected: it belongs to a different item.",
    ]);
  });

  const down = () => {
    const lumexia = new FakeLumexiaClient();
    lumexia.setDown(true);
    return lumexia;
  };
  const unknown = () => new FakeLumexiaClient();

  it.each([
    ["down", down],
    ["unconfigured", () => null],
    ["without that lot", unknown],
  ])(
    "saves it unverified with only its id when Lumexia is %s, and packing completes",
    async (_, make) => {
      const { packer, order, pkg, boxLine } = await packing();
      const id = crypto.randomUUID();

      await scanWith(make(), packer, { packageId: pkg.id, code: id });

      const rows = await db.packageItemLot.findMany({ where: { packageItemId: boxLine.id } });
      expect(rows).toMatchObject([
        { lotNumber: null, lumexiaLotId: id, quantity: 3, status: "UNVERIFIED" },
      ]);
      await expect(
        completePack(db, packer, { orderId: order.id, expectedVersion: 3, after: "queue" }),
      ).resolves.toEqual({ nextOrderId: null });
    },
  );

  it("asks which line when an unresolved lot fits more than one", async () => {
    const { packer, pkg, items } = await packing([{ quantity: 2 }, { quantity: 1 }]);
    await link(items[1]?.productId ?? null, "CAP9");
    const lines = await db.packageItem.findMany({
      where: { packageId: pkg.id },
      orderBy: { packedAt: "asc" },
    });
    const id = crypto.randomUUID();

    await expect(scanWith(down(), packer, { packageId: pkg.id, code: id })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.lumexia.chooseLine",
      candidates: [
        { packageItemId: lines[0]?.id, name: "Line 0", quantity: 2 },
        { packageItemId: lines[1]?.id, name: "Line 1", quantity: 1 },
      ],
    });
    expect(await db.packageItemLot.count()).toBe(0);

    await scanWith(down(), packer, {
      packageId: pkg.id,
      code: id,
      packageItemId: lines[1]?.id as string,
    });
    expect(
      await db.packageItemLot.findMany({ where: { packageItemId: lines[1]?.id as string } }),
    ).toMatchObject([{ lumexiaLotId: id, quantity: 1 }]);
  });
});

describe("scanLot: Which line?", () => {
  /** Two variations of one item in one box: both lines are BASE1234. */
  async function twoVariations() {
    const built = await packing([{ quantity: 2 }, { quantity: 3 }]);
    await link(built.items[1]?.productId ?? null, "BASE1234");
    const lines = await db.packageItem.findMany({
      where: { packageId: built.pkg.id },
      orderBy: { packedAt: "asc" },
    });
    return { ...built, lines };
  }

  it("refuses with the candidates, then applies the split rule to the chosen line", async () => {
    const { packer, pkg, lines } = await twoVariations();
    const [first, second] = lines.map((l) => ({ id: l.id })) as [{ id: string }, { id: string }];

    await expect(scan(packer, pkg.id, A)).rejects.toMatchObject({
      messageKey: "errors.lumexia.chooseLine",
      candidates: [
        { packageItemId: first.id, name: "Line 0", quantity: 2 },
        { packageItemId: second.id, name: "Line 1", quantity: 3 },
      ],
    });

    const pick = (code: string) =>
      scanLot(db, packer, { packageId: pkg.id, code, scanId: key(), packageItemId: second.id });
    await pick(A);
    await pick(B);
    expect(await lotsOf(second.id)).toBe("A12A0124:2 B07C1124:1");
    expect(await lotsOf(first.id)).toBe("");
  });

  it("refuses a chosen line the lot can't go on", async () => {
    const { packer, pkg, items } = await packing([{ quantity: 2 }, { quantity: 1 }]);
    const other = await db.packageItem.findFirstOrThrow({
      where: { packageId: pkg.id, orderItemId: items[1]?.id },
    });
    await expect(
      scanLot(db, packer, { packageId: pkg.id, code: A, scanId: key(), packageItemId: other.id }),
    ).rejects.toMatchObject({ messageKey: "errors.lumexia.lotNotOnPackage" });
  });

  it("puts a resolved QR lot on the chosen line of its item", async () => {
    const { packer, pkg, lines } = await twoVariations();
    const { lumexia, ours } = lumexiaWithLots();
    await expect(
      scanWith(lumexia, packer, { packageId: pkg.id, code: ours.id }),
    ).rejects.toMatchObject({ messageKey: "errors.lumexia.chooseLine" });
    await scanWith(lumexia, packer, {
      packageId: pkg.id,
      code: ours.id,
      packageItemId: lines[0]?.id as string,
    });
    expect(await lotsOf(lines[0]?.id as string)).toBe("A12A0124:2");
  });
});

describe("setLotQuantity and removeLot", () => {
  /** A 5-unit box line holding A:2 B:1 C:2. */
  async function threeLots() {
    const built = await packing([{ quantity: 5 }]);
    for (const code of [A, B, C, C]) await scan(built.packer, built.pkg.id, code);
    const rows = await db.packageItemLot.findMany({
      where: { packageItemId: built.boxLine.id },
      orderBy: { position: "asc" },
    });
    const [a, b, c] = rows.map((r) => r.id) as [string, string, string];
    return { ...built, a, b, c };
  }

  it("setLotQuantity moves the difference from or to the default lot, audited", async () => {
    const { packer, boxLine, b, c } = await threeLots();

    const result = await setLotQuantity(db, packer, { lotId: c, quantity: 3 });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:1 B07C1124:1 C01D0125:3");
    expect(result.packages[0]?.items[0]?.lots.map((l) => l.quantity)).toEqual([1, 1, 3]);
    await setLotQuantity(db, packer, { lotId: b, quantity: 1 }); // unchanged
    await setLotQuantity(db, packer, { lotId: c, quantity: 1 });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:3 B07C1124:1 C01D0125:1");

    const audit = await db.auditEvent.findMany({ where: { action: "lot.setQuantity" } });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ entityType: "PackageItem", entityId: boxLine.id });
  });

  it("setLotQuantity can't take the default below 1 or change the default itself", async () => {
    const { packer, boxLine, a, c } = await threeLots();

    await expect(setLotQuantity(db, packer, { lotId: c, quantity: 4 })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.lumexia.lotQuantity",
      params: { min: 1, max: 3 },
    });
    await expect(setLotQuantity(db, packer, { lotId: a, quantity: 1 })).rejects.toMatchObject({
      messageKey: "errors.lumexia.lotQuantity",
      params: { min: 2, max: 2 },
    });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 B07C1124:1 C01D0125:2");
  });

  it("removeLot gives its units to the default, and promotes the next when the default goes", async () => {
    const { packer, boxLine, a, b, c } = await threeLots();

    await removeLot(db, packer, { lotId: b });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:3 C01D0125:2");
    await removeLot(db, packer, { lotId: a });
    expect(await lotsOf(boxLine.id)).toBe("C01D0125:5");
    const result = await removeLot(db, packer, { lotId: c });
    expect(await db.packageItemLot.count()).toBe(0);
    expect(result.unmet.map((u) => u.messageKey)).toEqual(["errors.workflow.gate.lotMissing"]);
    expect(await db.auditEvent.count({ where: { action: "lot.remove" } })).toBe(3);
  });

  it("refuses a lot that doesn't exist", async () => {
    const { packer } = await threeLots();
    await expect(removeLot(db, packer, { lotId: crypto.randomUUID() })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("both need order.pack and the live claim", async () => {
    const { pkg, a, c } = await threeLots();
    void pkg;
    const picker = await createActor(db, ["PICKER"]);
    const otherPacker = await createActor(db, ["PACKER"]);

    for (const call of [
      (actor: UserActor) => setLotQuantity(db, actor, { lotId: c, quantity: 1 }),
      (actor: UserActor) => removeLot(db, actor, { lotId: a }),
    ]) {
      await expect(call(picker)).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await expect(call(otherPacker)).rejects.toMatchObject({
        messageKey: "errors.workflow.claimRequired",
      });
    }
    expect(await db.packageItemLot.count()).toBe(3);
  });
});
