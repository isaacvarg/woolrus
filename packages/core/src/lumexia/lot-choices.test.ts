import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { loadSettings } from "../settings/service";
import { LOT_CHOICES_MAX, lotChoices } from "./lot-choices";
import { scanLot } from "./lots";

// The pack screen's lot picker: a box line's Lumexia lots, newest first.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const BASE_TYPE = "0190a000-0000-7000-8000-0000000000b1";

/** A Packing order with one package of 3 units of line 0, linked to `item-BASE1234` unless not. */
async function packing({ linked = true } = {}) {
  const packer = await createActor(db, ["PACKER"]);
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: packer.userId,
    lines: [{ pickStatus: "PICKED", name: "Base", quantity: 3 }],
    packages: [{ items: [{ line: 0, quantity: 3 }], weightOz: 40 }],
  });
  const productId = built.items[0]?.productId as string;
  if (linked) {
    await db.product.update({
      where: { id: productId },
      data: {
        lumexiaItemId: "item-BASE1234",
        lumexiaItemRef: "BASE1234",
        lumexiaItemTypeId: BASE_TYPE,
      },
    });
  }
  const settings = await loadSettings(db);
  await db.settings.update({
    where: { id: settings.id },
    data: { lumexiaLotItemTypeIds: [BASE_TYPE] },
  });
  const pkg = built.packages[0] as { id: string };
  const orderItemId = built.items[0]?.id as string;
  const boxLine = await db.packageItem.findFirstOrThrow({
    where: { packageId: pkg.id, orderItemId },
  });
  return { packer, pkg, orderItemId, boxLine };
}

const choose = (
  lumexia: FakeLumexiaClient | null,
  actor: Awaited<ReturnType<typeof packing>>["packer"],
  input: { packageId: string; orderItemId: string },
) => lotChoices(db, actor, input, { connect: async () => lumexia });

describe("lotChoices", () => {
  it("lists the line's item's lots, newest first, and not another item's", async () => {
    const { packer, pkg, orderItemId, boxLine } = await packing();
    const lumexia = new FakeLumexiaClient();
    lumexia.addLot({
      itemId: "item-BASE1234",
      lotNumber: "BASE1234.A12A0124",
      createdAt: "2024-01-01T09:00:00.000Z",
    });
    lumexia.addLot({
      itemId: "item-BASE1234",
      lotNumber: "base1234.c01d0125",
      createdAt: "2025-04-01T09:00:00.000Z",
    });
    lumexia.addLot({
      itemId: "item-BASE1234",
      lotNumber: "BASE1234.B07C1124",
      createdAt: "2024-03-11T09:00:00.000Z",
    });
    lumexia.addLot({ itemId: "item-OTHER", lotNumber: "OTHER9.B01B0125" });

    const result = await choose(lumexia, packer, { packageId: pkg.id, orderItemId });

    expect(result.status).toBe("ok");
    expect(result.packageItemId).toBe(boxLine.id);
    expect(result.lots.map((l) => l.lotNumber)).toEqual([
      "BASE1234.C01D0125",
      "BASE1234.B07C1124",
      "BASE1234.A12A0124",
    ]);
    expect(lumexia.calls).toEqual([{ method: "listItemLots", args: ["item-BASE1234"] }]);
  });

  it(`keeps the newest ${LOT_CHOICES_MAX}`, async () => {
    const { packer, pkg, orderItemId } = await packing();
    const lumexia = new FakeLumexiaClient();
    for (let i = 0; i < LOT_CHOICES_MAX + 5; i++) {
      lumexia.addLot({
        itemId: "item-BASE1234",
        lotNumber: `BASE1234.A${String(i).padStart(2, "0")}A0124`,
        createdAt: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
      });
    }

    const { lots } = await choose(lumexia, packer, { packageId: pkg.id, orderItemId });

    expect(lots).toHaveLength(LOT_CHOICES_MAX);
    expect(lots[0]?.lotNumber).toBe(`BASE1234.A${LOT_CHOICES_MAX + 4}A0124`);
  });

  it("says why there's no list: not linked, not set up, or unreachable", async () => {
    const unlinked = await packing({ linked: false });
    expect(
      await choose(new FakeLumexiaClient(), unlinked.packer, {
        packageId: unlinked.pkg.id,
        orderItemId: unlinked.orderItemId,
      }),
    ).toEqual({ packageItemId: unlinked.boxLine.id, status: "notLinked", lots: [] });

    await resetDb(db);
    const { packer, pkg, orderItemId } = await packing();
    const input = { packageId: pkg.id, orderItemId };
    expect((await choose(null, packer, input)).status).toBe("unconfigured");
    const down = new FakeLumexiaClient();
    down.setDown(true);
    expect(await choose(down, packer, input)).toMatchObject({ status: "unavailable", lots: [] });
  });

  it("needs order.pack and a line in the package", async () => {
    const { pkg, orderItemId } = await packing();
    const picker = await createActor(db, ["PICKER"]);
    await expect(
      choose(new FakeLumexiaClient(), picker, { packageId: pkg.id, orderItemId }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    const packer = await createActor(db, ["PACKER"]);
    await expect(
      choose(new FakeLumexiaClient(), packer, {
        packageId: pkg.id,
        orderItemId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("a chosen lot goes on the line as a scan of its number would", async () => {
    const { packer, pkg, orderItemId, boxLine } = await packing();
    const lumexia = new FakeLumexiaClient();
    lumexia.addLot({ itemId: "item-BASE1234", lotNumber: "BASE1234.A12A0124" });
    const { lots, packageItemId } = await choose(lumexia, packer, {
      packageId: pkg.id,
      orderItemId,
    });

    await scanLot(db, packer, {
      packageId: pkg.id,
      code: lots[0]?.lotNumber as string,
      scanId: crypto.randomUUID(),
      packageItemId,
    });

    const rows = await db.packageItemLot.findMany({ where: { packageItemId: boxLine.id } });
    expect(rows).toMatchObject([{ lotNumber: "BASE1234.A12A0124", quantity: 3 }]);
  });
});
