import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { addPackage, scanIntoPackage } from "../packing/service";
import type { UserActor } from "../permissions";
import { scanBatch } from "../picking/batch-scan";
import { createBatch } from "../picking/batches";
import { scan } from "../picking/scan";
import { scanVerify } from "../qa/scan";
import { getOrderActivity } from "./timeline";

// SPEC-order-activity success criterion 3: each scan procedure, refused for each kind that
// applies, writes one ScanMiss and returns the same error as before.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const scanId = () => crypto.randomUUID();
const misses = () => db.scanMiss.findMany({ orderBy: { at: "asc" } });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/** A product that exists in the catalog but on another order. */
const otherProduct = () => createOrder(db, { lines: [{ name: "Mint balm", sku: "MINT" }] });

async function picking(lines: LineSpec[]) {
  const picker = await createActor(db, ["PICKER"]);
  const built = await createOrder(db, {
    status: "PICKING",
    version: 2,
    claimedById: picker.userId,
    lines,
  });
  return { picker, ...built };
}

describe("picking scan misses", () => {
  it("records an unknown code and rethrows the same refusal", async () => {
    const { picker, order } = await picking([{ sku: "LAV-8" }]);
    const id = scanId();

    await expect(
      scan(db, picker, { orderId: order.id, code: " zz-9 ", scanId: id }),
    ).rejects.toMatchObject({
      messageKey: "errors.picking.scanUnknown",
    });

    expect(await misses()).toEqual([
      expect.objectContaining({
        orderId: order.id,
        stage: "PICKING",
        kind: "UNKNOWN_CODE",
        code: "ZZ-9",
        productName: null,
        actorId: picker.userId,
        stationId: null,
        scanId: id,
        batchId: null,
      }),
    ]);
  });

  it("records a known product that isn't on the order, by name", async () => {
    await otherProduct();
    const { picker, order } = await picking([{ sku: "LAV-8" }]);

    await expect(
      scan(db, picker, { orderId: order.id, code: "MINT", scanId: scanId() }),
    ).rejects.toMatchObject({
      messageKey: "errors.picking.scanNotOnOrder",
      params: { name: "Mint balm" },
    });

    expect(await misses()).toEqual([
      expect.objectContaining({ kind: "NOT_ON_ORDER", productName: "Mint balm", code: "MINT" }),
    ]);
  });

  it("records an already picked line with its id", async () => {
    const { picker, order, items } = await picking([
      { name: "Lavender soap", sku: "LAV-8", quantity: 1, pickStatus: "PICKED" },
    ]);

    await expect(
      scan(db, picker, { orderId: order.id, code: "LAV-8", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanAlreadyPicked" });

    expect(await misses()).toEqual([
      expect.objectContaining({
        kind: "ALREADY_DONE",
        orderItemId: items[0]?.id,
        productName: "Lavender soap",
      }),
    ]);
  });

  it("writes one row for a replayed scan id", async () => {
    const { picker, order } = await picking([{ sku: "LAV-8" }]);
    const input = { orderId: order.id, code: "NOPE", scanId: scanId() };

    await expect(scan(db, picker, input)).rejects.toThrow();
    await expect(scan(db, picker, input)).rejects.toThrow();

    expect(await misses()).toHaveLength(1);
  });

  it("records nothing when the refusal isn't about the item (claim lost)", async () => {
    const { order } = await picking([{ sku: "LAV-8" }]);
    const someoneElse = await createActor(db, ["PICKER"]);

    await expect(
      scan(db, someoneElse, { orderId: order.id, code: "NOPE", scanId: scanId() }),
    ).rejects.toThrow();

    expect(await misses()).toEqual([]);
  });
});

describe("batch scan misses", () => {
  async function batchOf(picker: UserActor, lines: LineSpec[][]) {
    const built = [];
    for (const [i, orderLines] of lines.entries()) {
      built.push(await createOrder(db, { orderedAt: minutesAgo(100 - i), lines: orderLines }));
    }
    const batch = await createBatch(db, picker, {
      orders: built.map((b) => ({ id: b.order.id, expectedVersion: b.order.version })),
      idempotencyKey: crypto.randomUUID(),
    });
    return { batch, orders: built.map((b) => b.order) };
  }

  it("records a code no order matches against the batch's first order", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch, orders } = await batchOf(picker, [[{ sku: "AAA" }], [{ sku: "BBB" }]]);

    await expect(
      scanBatch(db, picker, { batchId: batch.id, code: "NOPE", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanUnknown" });

    expect(await misses()).toEqual([
      expect.objectContaining({
        orderId: orders[0]?.id,
        batchId: batch.id,
        stage: "PICKING",
        kind: "UNKNOWN_CODE",
      }),
    ]);
  });

  it("records an already picked line against the order it is on", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { batch, orders } = await batchOf(picker, [
      [{ sku: "AAA" }],
      [{ name: "Bee balm", sku: "BBB", quantity: 1 }],
    ]);
    await scanBatch(db, picker, { batchId: batch.id, code: "BBB", scanId: scanId() });

    await expect(
      scanBatch(db, picker, { batchId: batch.id, code: "BBB", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanAlreadyPicked" });

    expect(await misses()).toEqual([
      expect.objectContaining({
        orderId: orders[1]?.id,
        batchId: batch.id,
        kind: "ALREADY_DONE",
        productName: "Bee balm",
      }),
    ]);
  });
});

describe("packing scan misses", () => {
  async function packing(lines: LineSpec[]) {
    const packer = await createActor(db, ["PACKER"]);
    const built = await createOrder(db, {
      status: "PACKING",
      version: 3,
      claimedById: packer.userId,
      lines: lines.map((l) => ({ pickStatus: "PICKED" as const, ...l })),
    });
    const box = await db.box.create({
      data: { name: "Medium", lengthIn: 12, widthIn: 10, heightIn: 8, maxWeightOz: 400 },
    });
    const { packages } = await addPackage(db, packer, {
      orderId: built.order.id,
      box: { boxId: box.id },
      idempotencyKey: crypto.randomUUID(),
    });
    return { packer, ...built, pkg: packages[0]?.id as string };
  }

  it("records a product not on the order, in the package scanned into", async () => {
    await otherProduct();
    const { packer, order, pkg } = await packing([{ sku: "AAA" }]);

    await expect(
      scanIntoPackage(db, packer, { packageId: pkg, code: "MINT", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.picking.scanNotOnOrder" });

    expect(await misses()).toEqual([
      expect.objectContaining({
        orderId: order.id,
        stage: "PACKING",
        kind: "NOT_ON_ORDER",
        packageId: pkg,
        productName: "Mint balm",
      }),
    ]);
  });

  it("records a line with every unit boxed", async () => {
    const { packer, order, pkg, items } = await packing([{ name: "Jar", sku: "JAR", quantity: 1 }]);
    await scanIntoPackage(db, packer, { packageId: pkg, code: "JAR", scanId: scanId() });

    await expect(
      scanIntoPackage(db, packer, { packageId: pkg, code: "JAR", scanId: scanId() }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.scanAlreadyPacked" });

    expect(await misses()).toEqual([
      expect.objectContaining({
        orderId: order.id,
        kind: "ALREADY_DONE",
        orderItemId: items[0]?.id,
        packageId: pkg,
      }),
    ]);
  });
});

describe("QA scan misses", () => {
  async function inQa() {
    const qa = await createActor(db, ["QA"]);
    const built = await createOrder(db, {
      status: "QA",
      claimedById: qa.userId,
      lines: [
        { name: "Jar", quantity: 1, pickStatus: "PICKED", sku: "JAR-1" },
        { name: "Candle", quantity: 1, pickStatus: "PICKED", sku: "CANDLE-1" },
      ],
      packages: [{ items: [{ line: 0, quantity: 1 }] }, { items: [{ line: 1, quantity: 1 }] }],
    });
    const [p1, p2] = built.packages.map((p) => p.id) as [string, string];
    const input = (code: string, packageId = p1) => ({
      orderId: built.order.id,
      packageId,
      code,
      scanId: scanId(),
    });
    return { qa, ...built, p1, p2, input };
  }

  it("records an item that is in another box, naming that box", async () => {
    const { qa, order, items, p2, input } = await inQa();

    await expect(scanVerify(db, qa, input("CANDLE-1"))).rejects.toMatchObject({
      messageKey: "errors.qa.scanOtherPackage",
    });

    expect(await misses()).toEqual([
      expect.objectContaining({
        orderId: order.id,
        stage: "QA",
        kind: "OTHER_PACKAGE",
        orderItemId: items[1]?.id,
        packageId: p2,
        productName: "Candle",
      }),
    ]);
  });

  it("records unknown codes and already verified rows", async () => {
    const { qa, input, p1, items } = await inQa();
    await scanVerify(db, qa, input("JAR-1"));

    await expect(scanVerify(db, qa, input("JAR-1"))).rejects.toMatchObject({
      messageKey: "errors.qa.scanAlreadyVerified",
    });
    await expect(scanVerify(db, qa, input("NOPE"))).rejects.toMatchObject({
      messageKey: "errors.picking.scanUnknown",
    });

    expect((await misses()).map((m) => [m.kind, m.orderItemId, m.packageId])).toEqual([
      ["ALREADY_DONE", items[0]?.id, p1],
      ["UNKNOWN_CODE", null, p1],
    ]);
  });

  it("records nothing while a label purchase is in progress", async () => {
    const qa = await createActor(db, ["QA"]);
    const { order, packages } = await createOrder(db, {
      status: "QA",
      claimedById: qa.userId,
      lines: [{ quantity: 1, pickStatus: "PICKED", sku: "JAR-1" }],
      packages: [{ items: [{ line: 0, quantity: 1 }], label: "PURCHASING" }],
    });
    const input = {
      orderId: order.id,
      packageId: packages[0]?.id as string,
      code: "NOPE",
      scanId: scanId(),
    };

    await expect(scanVerify(db, qa, input)).rejects.toMatchObject({
      messageKey: "errors.qa.purchaseInProgress",
    });
    expect(await misses()).toEqual([]);
  });
});

describe("scan misses in the timeline", () => {
  it("shows each miss under Problems, never grouped, with its target", async () => {
    await otherProduct();
    const { picker, order } = await picking([{ name: "Lavender soap", sku: "LAV-8" }]);
    for (let i = 0; i < 2; i++) {
      await expect(
        scan(db, picker, { orderId: order.id, code: "MINT", scanId: scanId() }),
      ).rejects.toThrow();
    }

    const { entries } = await getOrderActivity(db, picker, { id: order.id });
    const shown = entries.filter((e) => e.category === "problems");

    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatchObject({
      count: 1,
      action: "scanMiss.notOnOrder",
      entityType: "ScanMiss",
      actor: { id: picker.userId },
      params: { stage: "PICKING", name: "Mint balm", code: "MINT", batch: "no" },
      target: null,
      details: null,
    });
  });
});
