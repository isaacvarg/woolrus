import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { scan } from "./scan";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/** A Picking order claimed by a fresh picker. */
async function picking(lines: LineSpec[]) {
  const picker = await createActor(db, ["PICKER"]);
  const built = await createOrder(db, {
    status: "PICKING",
    version: 2,
    claimedById: picker.userId,
    claimedAt: new Date(),
    lines,
  });
  return { picker, ...built };
}

const lineRow = (id: string) => db.orderItem.findUniqueOrThrow({ where: { id } });
const scanId = () => crypto.randomUUID();
const id = (item: { id: string } | undefined) => item?.id as string;

describe("scan", () => {
  it.each([
    ["the variation barcode", { variation: { barcode: "111" } }, "111"],
    ["the product barcode", { barcode: "222" }, "222"],
    ["the variation SKU", { variation: { sku: "VAR-1" } }, "VAR-1"],
    ["the product and line SKU", { sku: "LAV-8" }, "LAV-8"],
  ] as const)("matches by %s and adds one unit", async (_, spec, code) => {
    const { picker, order, items } = await picking([{ quantity: 3, ...spec }]);

    const result = await scan(db, picker, { orderId: order.id, code, scanId: scanId() });

    expect(result.line).toMatchObject({
      id: id(items[0]),
      pickStatus: "PENDING",
      pickedQuantity: 1,
    });
    expect(result.line.pickedBy?.name).toBe("Test User");
    expect(result).toMatchObject({ done: 0, total: 1 });
  });

  it("ignores case and surrounding spaces", async () => {
    const { picker, order, items } = await picking([{ sku: "LAV-8", quantity: 2 }]);

    await scan(db, picker, { orderId: order.id, code: "  lav-8 ", scanId: scanId() });

    expect(await lineRow(id(items[0]))).toMatchObject({ pickedQuantity: 1 });
  });

  it("marks the line picked when the last unit is scanned", async () => {
    const { picker, order, items } = await picking([
      { sku: "LAV-8", quantity: 2, pickedQuantity: 1 },
    ]);

    const result = await scan(db, picker, { orderId: order.id, code: "LAV-8", scanId: scanId() });

    expect(result.line).toMatchObject({ pickStatus: "PICKED", pickedQuantity: 2 });
    expect(result).toMatchObject({ done: 1, total: 1 });
    expect(await lineRow(id(items[0]))).toMatchObject({
      pickStatus: "PICKED",
      pickedById: picker.userId,
    });
  });

  it("fills two lines sharing a SKU in pick order", async () => {
    const { picker, order, items } = await picking([
      { name: "Soap (gift wrap)", sku: "SOAP", quantity: 1 },
      { name: "Soap", sku: "SOAP", quantity: 1 },
    ]);
    const [wrapped, plain] = items;

    const first = await scan(db, picker, { orderId: order.id, code: "SOAP", scanId: scanId() });
    const second = await scan(db, picker, { orderId: order.id, code: "SOAP", scanId: scanId() });

    expect(first.line.id).toBe(id(plain));
    expect(second.line.id).toBe(id(wrapped));
    expect(second).toMatchObject({ done: 2, total: 2 });
  });

  it("skips a matching line that is Out of Stock or Substituted", async () => {
    const { picker, order, items } = await picking([
      { name: "A soap", sku: "SOAP", quantity: 2, pickStatus: "OUT_OF_STOCK", pickedQuantity: 1 },
      { name: "B soap", sku: "SOAP", quantity: 1, pickStatus: "SUBSTITUTED" },
      { name: "C soap", sku: "SOAP", quantity: 1 },
    ]);

    const result = await scan(db, picker, { orderId: order.id, code: "SOAP", scanId: scanId() });

    expect(result.line.id).toBe(id(items[2]));
  });

  it("counts a replayed scanId once", async () => {
    const { picker, order, items } = await picking([{ sku: "LAV-8", quantity: 3 }]);
    const input = { orderId: order.id, code: "LAV-8", scanId: scanId() };

    await scan(db, picker, input);
    const replay = await scan(db, picker, input);

    expect(replay.line).toMatchObject({ id: id(items[0]), pickedQuantity: 1 });
    expect(await lineRow(id(items[0]))).toMatchObject({ pickedQuantity: 1 });
  });

  it("is audited as pick.scan and leaves the order's version alone", async () => {
    const { picker, order, items } = await picking([{ sku: "LAV-8", quantity: 3 }]);

    await scan(db, picker, { orderId: order.id, code: "LAV-8", scanId: scanId() });

    expect(await db.auditEvent.findMany({ where: { entityId: id(items[0]) } })).toMatchObject([
      {
        action: "pick.scan",
        before: { pickStatus: "PENDING", pickedQuantity: 0 },
        after: { pickStatus: "PENDING", pickedQuantity: 1 },
      },
    ]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
  });

  describe("refuses, changing nothing and auditing nothing,", () => {
    const untouched = async (itemId: string, pickedQuantity = 0) => {
      expect(await lineRow(itemId)).toMatchObject({ pickedQuantity });
      expect(await db.auditEvent.count()).toBe(0);
    };

    it("a product that isn't on the order, naming it", async () => {
      const { picker, order, items } = await picking([{ sku: "LAV-8" }]);
      await createOrder(db, { lines: [{ name: "Lavender soap 16 oz", barcode: "999" }] });

      await expect(
        scan(db, picker, { orderId: order.id, code: "999", scanId: scanId() }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.scanNotOnOrder",
        params: { name: "Lavender soap 16 oz" },
      });
      await untouched(id(items[0]));
    });

    it("a variation that isn't on the order, by its SKU", async () => {
      const { picker, order } = await picking([{ sku: "LAV-8" }]);
      await createOrder(db, { lines: [{ name: "Rose soap", variation: { sku: "rose-16" } }] });

      await expect(
        scan(db, picker, { orderId: order.id, code: "ROSE-16", scanId: scanId() }),
      ).rejects.toMatchObject({
        messageKey: "errors.picking.scanNotOnOrder",
        params: { name: "Rose soap" },
      });
    });

    it("a code nobody knows", async () => {
      const { picker, order, items } = await picking([{ sku: "LAV-8" }]);

      await expect(
        scan(db, picker, { orderId: order.id, code: "000", scanId: scanId() }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.picking.scanUnknown" });
      await untouched(id(items[0]));
    });

    it("a line already picked, naming it", async () => {
      const { picker, order, items } = await picking([
        { name: "Lavender soap", sku: "LAV-8", quantity: 2, pickStatus: "PICKED" },
      ]);

      await expect(
        scan(db, picker, { orderId: order.id, code: "LAV-8", scanId: scanId() }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.scanAlreadyPicked",
        params: { line: "Lavender soap" },
      });
      await untouched(id(items[0]), 2);
    });

    it("a line nobody picks (voided or not physical)", async () => {
      const { picker, order } = await picking([
        { sku: "RUSH", physical: false },
        { sku: "GONE", quantity: 1, voids: [{ quantity: 1 }] },
      ]);

      for (const code of ["RUSH", "GONE"]) {
        await expect(
          scan(db, picker, { orderId: order.id, code, scanId: scanId() }),
        ).rejects.toMatchObject({ messageKey: "errors.picking.scanNotOnOrder" });
      }
    });

    it("when the order isn't in Picking", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { order, items } = await createOrder(db, {
        claimedById: picker.userId,
        lines: [{ sku: "LAV-8" }],
      });

      await expect(
        scan(db, picker, { orderId: order.id, code: "LAV-8", scanId: scanId() }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.notPicking" });
      await untouched(id(items[0]));
    });

    it("when the actor doesn't hold the claim", async () => {
      const { order, items } = await picking([{ sku: "LAV-8" }]);
      const other = await createActor(db, ["PICKER"]);

      await expect(
        scan(db, other, { orderId: order.id, code: "LAV-8", scanId: scanId() }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.claimRequired" });
      await untouched(id(items[0]));
    });

    it("for someone who can't pick", async () => {
      const { order, items } = await picking([{ sku: "LAV-8" }]);
      const packer = await createActor(db, ["PACKER"]);

      await expect(
        scan(db, packer, { orderId: order.id, code: "LAV-8", scanId: scanId() }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await untouched(id(items[0]));
    });

    it("for an order that doesn't exist", async () => {
      const picker = await createActor(db, ["PICKER"]);

      await expect(
        scan(db, picker, {
          orderId: "00000000-0000-7000-8000-000000000000",
          code: "LAV-8",
          scanId: scanId(),
        }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    });
  });

  it("lets a refused scanId be retried once the problem is fixed", async () => {
    const { picker, order, items } = await picking([{ sku: "LAV-8" }]);
    const input = { orderId: order.id, code: "NEW-CODE", scanId: scanId() };
    await expect(scan(db, picker, input)).rejects.toMatchObject({
      messageKey: "errors.picking.scanUnknown",
    });
    await db.product.updateMany({ data: { barcode: "NEW-CODE" } });

    const result = await scan(db, picker, input);

    expect(result.line).toMatchObject({ id: id(items[0]), pickedQuantity: 1 });
  });
});
