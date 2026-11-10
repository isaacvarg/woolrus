import type { Db, LotStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type OrderSpec } from "../../test/factories";
import { csvStream } from "../csv";
import { loadSettings } from "../settings/service";
import { getOrder } from "../workflow/queries";
import { LOT_LOOKUP_CSV_HEADER, lookupLot, lotLookupCsv } from "./lookup";

// SPEC-lumexia "Reads and UI": Lot lookup (success criterion 12) and lots on the order detail page.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const A = "BASE1234.A12A0124";
const B = "BASE1234.B07C1124";
const A_ID = "0190a000-0000-7000-8000-0000000000a1";

type LotSpec = {
  lotNumber: string | null;
  lumexiaLotId?: string;
  quantity: number;
  status?: LotStatus;
};

/** An order with one package holding `quantity` units of one line, carrying `lots`. */
async function shipped(
  lots: LotSpec[],
  { quantity = 3, ...spec }: OrderSpec & { quantity?: number; discarded?: boolean } = {},
) {
  const built = await createOrder(db, {
    status: "COMPLETED",
    ...spec,
    lines: [{ quantity, name: "Base cream", pickStatus: "PICKED" }],
    packages: [{ items: [{ line: 0, quantity }] }],
  });
  const pkg = built.packages[0] as { id: string };
  const boxLine = await db.packageItem.findFirstOrThrow({ where: { packageId: pkg.id } });
  for (const [position, lot] of lots.entries()) {
    await db.packageItemLot.create({
      data: {
        packageItemId: boxLine.id,
        lotNumber: lot.lotNumber,
        lumexiaLotId: lot.lumexiaLotId ?? null,
        quantity: lot.quantity,
        position,
        status: lot.status ?? "UNVERIFIED",
      },
    });
  }
  return { ...built, pkg, boxLine };
}

describe("lookupLot", () => {
  it("finds every package item that shipped a lot number, across orders, ignoring case", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const first = await shipped(
      [
        { lotNumber: A, quantity: 2, status: "VALID" },
        { lotNumber: B, quantity: 1 },
      ],
      {
        number: "1001",
        customerName: "Ada Lovelace",
      },
    );
    const second = await shipped([{ lotNumber: A, quantity: 4 }], {
      number: "1002",
      customerName: "Grace Hopper",
      status: "PACKING",
      quantity: 4,
    });
    await shipped([{ lotNumber: B, quantity: 3 }], { number: "1003" });

    const result = await lookupLot(db, shipper, { code: " base1234.a12a0124 " });

    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        {
          id: expect.any(String),
          orderId: first.order.id,
          orderNumber: "1001",
          customerName: "Ada Lovelace",
          packageNumber: 1,
          productName: "Base cream",
          lotNumber: A,
          lumexiaLotId: null,
          quantity: 2,
          status: "VALID",
          shippedAt: first.order.completedAt,
        },
        expect.objectContaining({
          orderId: second.order.id,
          orderNumber: "1002",
          quantity: 4,
          status: "UNVERIFIED",
          // Not shipped yet: still traceable, with no shipped date.
          shippedAt: null,
        }),
      ]),
    );
  });

  it("matches a QR scan's UUID on the Lumexia lot id", async () => {
    const reader = await createActor(db, ["PICKER"]);
    await shipped([{ lotNumber: A, lumexiaLotId: A_ID, quantity: 3 }], { number: "2001" });
    // An unresolved QR scan: no number yet, only the id.
    await shipped([{ lotNumber: null, lumexiaLotId: A_ID, quantity: 1 }], {
      number: "2002",
      quantity: 1,
    });
    await shipped([{ lotNumber: A, quantity: 3 }], { number: "2003" });

    const result = await lookupLot(db, reader, { code: A_ID.toUpperCase() });

    expect(result.rows.map((r) => r.orderNumber).sort()).toEqual(["2001", "2002"]);
  });

  it("leaves out packages a repack threw away, and returns nothing for an unknown lot", async () => {
    const reader = await createActor(db, ["QA"]);
    const { pkg } = await shipped([{ lotNumber: A, quantity: 3 }]);
    await db.package.update({ where: { id: pkg.id }, data: { discardedAt: new Date() } });

    expect((await lookupLot(db, reader, { code: A })).rows).toEqual([]);
    expect((await lookupLot(db, reader, { code: "BASE1234.Z99L3199" })).rows).toEqual([]);
  });

  it("needs order.read", async () => {
    const nobody = await createActor(db, []);
    await expect(lookupLot(db, nobody, { code: A })).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(lotLookupCsv(db, nobody, { code: A })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("lotLookupCsv", () => {
  it("has the screen's rows and columns", async () => {
    const reader = await createActor(db, ["PACKER"]);
    await shipped([{ lotNumber: A, quantity: 2, status: "WRONG_ITEM" }], {
      number: "3001",
      customerName: "=Mallory",
      quantity: 2,
    });
    await shipped([{ lotNumber: A, quantity: 1 }], { number: "3002", status: "QA", quantity: 1 });

    const screen = await lookupLot(db, reader, { code: A });
    const csv = await lotLookupCsv(db, reader, { code: A });
    const text = await new Response(csvStream(csv.header, csv.rows)).text();
    const lines = text.replace(/^﻿/, "").trimEnd().split("\r\n");

    expect(csv.header).toBe(LOT_LOOKUP_CSV_HEADER);
    expect(lines[0]).toBe("Order,Customer,Package,Product,Lot,Quantity,Lot status,Shipped");
    expect(lines.slice(1)).toEqual(
      screen.rows.map((r) =>
        [
          r.orderNumber,
          // Formula-looking names are defused by core/csv.
          r.customerName === "=Mallory" ? "'=Mallory" : r.customerName,
          r.packageNumber,
          r.productName,
          r.lotNumber,
          r.quantity,
          r.status,
          r.shippedAt ? r.shippedAt.toISOString() : "",
        ].join(","),
      ),
    );
    expect(csv.filename).toBe("lot-BASE1234.A12A0124.csv");
  });
});

describe("getOrder: lots per package item", () => {
  it("shows each box line's lots with status, and whether it needs one", async () => {
    const reader = await createActor(db, ["PICKER"]);
    const { order, items } = await shipped([
      { lotNumber: A, quantity: 2, status: "VALID" },
      { lotNumber: B, quantity: 1, status: "NOT_FOUND" },
    ]);
    const TYPE = "0190a000-0000-7000-8000-0000000000b1";
    await db.product.update({
      where: { id: items[0]?.productId as string },
      data: { lumexiaItemId: "item-1", lumexiaItemRef: "BASE1234", lumexiaItemTypeId: TYPE },
    });
    const settings = await loadSettings(db);
    await db.settings.update({
      where: { id: settings.id },
      data: { lumexiaLotItemTypeIds: [TYPE] },
    });

    const view = await getOrder(db, reader, { id: order.id });

    expect(view.packages[0]?.items[0]).toMatchObject({
      needsLot: true,
      lots: [
        { lotNumber: A, quantity: 2, status: "VALID", isDefault: true },
        { lotNumber: B, quantity: 1, status: "NOT_FOUND", isDefault: false },
      ],
    });
  });

  it("an unlinked line needs no lot and has none", async () => {
    const reader = await createActor(db, ["PICKER"]);
    const { order } = await shipped([]);
    const view = await getOrder(db, reader, { id: order.id });
    expect(view.packages[0]?.items[0]).toMatchObject({ needsLot: false, lots: [] });
  });
});
