import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import type { UserActor } from "../permissions";
import { scanBatch } from "./batch-scan";
import { createBatch, getBatch } from "./batches";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const scanId = () => crypto.randomUUID();

/** A product with a barcode, as a line other orders can share with `sameAs`. */
async function product(spec: LineSpec) {
  const { items } = await createOrder(db, { lines: [spec] });
  return items[0] as NonNullable<(typeof items)[0]>;
}

/** Pending orders with these lines, begun as one batch; slots follow the list. */
async function batchOf(picker: UserActor, lines: LineSpec[][]) {
  const built = [];
  for (const [i, orderLines] of lines.entries()) {
    built.push(await createOrder(db, { orderedAt: minutesAgo(100 - i), lines: orderLines }));
  }
  const batch = await createBatch(db, picker, {
    orders: built.map((b) => ({ id: b.order.id, expectedVersion: b.order.version })),
    idempotencyKey: crypto.randomUUID(),
  });
  return { batch, built };
}

const picked = (orderId: string) =>
  db.orderItem.findMany({ where: { orderId }, select: { pickedQuantity: true } });

describe("scanBatch", () => {
  it("fills slots in order, a unit at a time, and returns the slot", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const soap = await product({ name: "Lavender soap", barcode: "111", variation: {} });
    const { batch, built } = await batchOf(picker, [
      [{ sameAs: soap, quantity: 2 }],
      [{ name: "Mint balm", sku: "MINT" }],
      [{ sameAs: soap, quantity: 1 }],
    ]);
    const [one, , three] = built.map((b) => b.order);

    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await scanBatch(db, picker, { batchId: batch.id, code: "111", scanId: scanId() }),
      );
    }

    expect(results.map((r) => [r.slot, r.orderId, r.number])).toEqual([
      [1, one?.id, one?.number],
      [1, one?.id, one?.number],
      [3, three?.id, three?.number],
    ]);
    const lines = await db.orderItem.findMany({
      where: { id: { in: results.map((r) => r.itemId) } },
    });
    expect(lines.map((l) => [l.orderId, l.pickStatus, l.pickedQuantity]).sort()).toEqual(
      [
        [one?.id, "PICKED", 2],
        [three?.id, "PICKED", 1],
      ].sort(),
    );
    expect(await db.auditEvent.count({ where: { action: "pick.scan" } })).toBe(3);
  });

  it("matches by SKU, ignoring case and spaces", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch, built } = await batchOf(picker, [[{ sku: "LAV-8" }], [{ sku: "LAV-8" }]]);

    const result = await scanBatch(db, picker, {
      batchId: batch.id,
      code: " lav-8 ",
      scanId: scanId(),
    });

    expect(result).toMatchObject({ slot: 1, orderId: built[0]?.order.id });
  });

  it("skips orders that left the batch", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PICKER"]);
    const soap = await product({ barcode: "111" });
    const { batch } = await batchOf(picker, [
      [{ sameAs: soap }],
      [{ sameAs: soap }],
      [{ sameAs: soap }],
      [{ sameAs: soap }],
    ]);
    const [held, taken, removed, live] = batch.members.map((m) => m.orderId);
    await db.order.update({ where: { id: held }, data: { status: "ON_HOLD" } });
    await db.order.update({ where: { id: taken }, data: { claimedById: other.userId } });
    await db.pickBatchOrder.update({
      where: { batchId_orderId: { batchId: batch.id, orderId: removed as string } },
      data: { removedAt: new Date() },
    });

    const result = await scanBatch(db, picker, {
      batchId: batch.id,
      code: "111",
      scanId: scanId(),
    });

    expect(result).toMatchObject({ slot: 4, orderId: live });
    for (const orderId of [held, taken, removed]) {
      expect(await picked(orderId as string)).toEqual([{ pickedQuantity: 0 }]);
    }
  });

  it("counts a replayed scanId once", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch, built } = await batchOf(picker, [[{ sku: "LAV-8", quantity: 3 }], [{}]]);
    const input = { batchId: batch.id, code: "LAV-8", scanId: scanId() };

    const first = await scanBatch(db, picker, input);
    const replay = await scanBatch(db, picker, input);

    expect(replay).toEqual(first);
    expect(await picked(built[0]?.order.id as string)).toEqual([{ pickedQuantity: 1 }]);
  });

  it("answers a replayed scanId after the batch closed", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch, built } = await batchOf(picker, [[{ sku: "LAV-8", quantity: 3 }], [{}]]);
    const input = { batchId: batch.id, code: "LAV-8", scanId: scanId() };
    const first = await scanBatch(db, picker, input);
    await db.pickBatch.update({ where: { id: batch.id }, data: { closedAt: new Date() } });

    await expect(scanBatch(db, picker, input)).resolves.toEqual(first);
    expect(await picked(built[0]?.order.id as string)).toEqual([{ pickedQuantity: 1 }]);
  });

  it("closes a batch with nothing live left, then refuses the scan", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch } = await batchOf(picker, [[{ sku: "LAV-8" }], [{ sku: "LAV-8" }]]);
    await db.order.updateMany({
      where: { id: { in: batch.members.map((m) => m.orderId) } },
      data: { status: "ON_HOLD" },
    });

    await expect(
      scanBatch(db, picker, { batchId: batch.id, code: "LAV-8", scanId: scanId() }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.picking.batchClosed" });

    // The close commits even though the scan was refused.
    expect(await db.pickBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
      closedAt: expect.any(Date),
    });
    expect(
      await db.auditEvent.count({ where: { entityId: batch.id, action: "pickBatch.close" } }),
    ).toBe(1);
  });

  it("shows on the batch list", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch } = await batchOf(picker, [[{ sku: "LAV-8", quantity: 2 }], [{ sku: "LAV-8" }]]);

    await scanBatch(db, picker, { batchId: batch.id, code: "LAV-8", scanId: scanId() });

    const read = await getBatch(db, picker, { id: batch.id });
    expect(read.groups.flatMap((g) => g.chips.map((c) => c.line.pickedQuantity))).toEqual([1, 0]);
  });

  describe("refuses, changing nothing and auditing nothing,", () => {
    async function setup() {
      const picker = await createActor(db, ["PICKER"]);
      const { batch, built } = await batchOf(picker, [
        [{ name: "Lavender soap", sku: "LAV-8", pickStatus: "PICKED" }],
        [{ name: "Mint balm", sku: "MINT" }],
      ]);
      const audits = await db.auditEvent.count();
      const untouched = async () => {
        expect(await picked(built[0]?.order.id as string)).toEqual([{ pickedQuantity: 1 }]);
        expect(await picked(built[1]?.order.id as string)).toEqual([{ pickedQuantity: 0 }]);
        expect(await db.auditEvent.count()).toBe(audits);
      };
      return { picker, batch, untouched };
    }

    it("a product that isn't in the batch, naming it", async () => {
      const { picker, batch, untouched } = await setup();
      await createOrder(db, { lines: [{ name: "Rose soap", barcode: "999" }] });

      await expect(
        scanBatch(db, picker, { batchId: batch.id, code: "999", scanId: scanId() }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.scanNotInBatch",
        params: { name: "Rose soap" },
      });
      await untouched();
    });

    it("a code nobody knows, offering to link it only to Admins", async () => {
      const { picker, batch, untouched } = await setup();

      const refusal = await scanBatch(db, picker, {
        batchId: batch.id,
        code: "000",
        scanId: scanId(),
      }).catch((e: unknown) => e);
      expect(refusal).toMatchObject({ kind: "CONFLICT", messageKey: "errors.picking.scanUnknown" });
      expect(refusal).not.toHaveProperty("canLink", true);

      // Roles live on the actor; the same picker with Admin added.
      const admin = { ...picker, roles: [...picker.roles, "ADMIN" as const] };
      await expect(
        scanBatch(db, admin, { batchId: batch.id, code: "000", scanId: scanId() }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.scanUnknown", canLink: true });
      await untouched();
    });

    it("a product whose every unit is picked, naming it", async () => {
      const { picker, batch, untouched } = await setup();

      await expect(
        scanBatch(db, picker, { batchId: batch.id, code: "LAV-8", scanId: scanId() }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.picking.scanAlreadyPicked",
        params: { line: "Lavender soap" },
      });
      await untouched();
    });

    it("a product only on an order that left the batch", async () => {
      const { picker, batch, untouched } = await setup();
      await db.order.update({
        where: { id: batch.members[1]?.orderId },
        data: { status: "ON_HOLD" },
      });

      await expect(
        scanBatch(db, picker, { batchId: batch.id, code: "MINT", scanId: scanId() }),
      ).rejects.toMatchObject({ messageKey: "errors.picking.scanNotInBatch" });
      await untouched();
    });

    it("for someone else's batch", async () => {
      const { batch, untouched } = await setup();
      const other = await createActor(db, ["PICKER"]);

      await expect(
        scanBatch(db, other, { batchId: batch.id, code: "MINT", scanId: scanId() }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await untouched();
    });

    it("for someone who can't pick", async () => {
      const { batch, untouched } = await setup();
      const packer = await createActor(db, ["PACKER"]);

      await expect(
        scanBatch(db, packer, { batchId: batch.id, code: "MINT", scanId: scanId() }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await untouched();
    });

    it("for a closed batch", async () => {
      const { picker, batch, untouched } = await setup();
      await db.pickBatch.update({ where: { id: batch.id }, data: { closedAt: new Date() } });

      await expect(
        scanBatch(db, picker, { batchId: batch.id, code: "MINT", scanId: scanId() }),
      ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.picking.batchClosed" });
      await untouched();
    });

    it("for a batch that doesn't exist", async () => {
      const picker = await createActor(db, ["PICKER"]);

      await expect(
        scanBatch(db, picker, {
          batchId: "00000000-0000-7000-8000-000000000000",
          code: "MINT",
          scanId: scanId(),
        }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    });
  });
});
