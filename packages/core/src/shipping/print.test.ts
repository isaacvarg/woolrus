import { CreateLabelPrintInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createMemoryStorage } from "../adapters/storage/memory";
import { AppError } from "../errors";
import { createLabelPrint, labelPrintPdf, orderPrintableLabels, PRINT_TTL_MS } from "./print";

// Print and reprint (SPEC-shipping "Print", success criterion 1).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const storage = createMemoryStorage();

/** A stored label PDF whose page width is `marker`, so the merge order can be read back. */
async function storeLabel(labelId: string, marker: number) {
  const doc = await PDFDocument.create();
  doc.addPage([marker, 432]);
  const key = `labels/${labelId}.pdf`;
  await storage.put(key, await doc.save(), "application/pdf");
  await db.shippingLabel.update({ where: { id: labelId }, data: { storageKey: key } });
}

/** An order with one ACTIVE, stored label per package. */
async function orderWithLabels(status: "READY" | "COMPLETED", markers: number[]) {
  const built = await createOrder(db, {
    status,
    packages: markers.map(() => ({ label: "ACTIVE" as const })),
  });
  const labels = await db.shippingLabel.findMany({
    where: { package: { orderId: built.order.id } },
    orderBy: { package: { number: "asc" } },
  });
  for (const [i, label] of labels.entries()) await storeLabel(label.id, markers[i] as number);
  return { order: built.order, labels };
}

const widths = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth());
const key = () => `print-${crypto.randomUUID()}`;

describe("createLabelPrint", () => {
  it("merges orders in the given order then package order, counting each label, changing nothing else", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const a = await orderWithLabels("READY", [101, 102]);
    const b = await orderWithLabels("READY", [201]);
    const before = await db.order.findUniqueOrThrow({ where: { id: a.order.id } });

    const { printId, labelCount } = await createLabelPrint(db, shipper, {
      orderIds: [b.order.id, a.order.id],
      idempotencyKey: key(),
    });
    expect(labelCount).toBe(3);
    expect(await widths(await labelPrintPdf(db, shipper, storage, printId))).toEqual([
      201, 101, 102,
    ]);

    const counts = await db.shippingLabel.findMany({
      select: { printCount: true, lastPrintedAt: true },
    });
    expect(counts.every((l) => l.printCount === 1 && l.lastPrintedAt)).toBe(true);
    const after = await db.order.findUniqueOrThrow({ where: { id: a.order.id } });
    expect([after.status, after.version]).toEqual([before.status, before.version]);
    expect(await db.auditEvent.count({ where: { action: "label.print" } })).toBe(2);
  });

  it("reprints one label, and a Completed order's labels", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const a = await orderWithLabels("READY", [101, 102]);
    const second = a.labels[1]?.id as string;
    const one = await createLabelPrint(db, shipper, { labelIds: [second], idempotencyKey: key() });
    expect(await widths(await labelPrintPdf(db, shipper, storage, one.printId))).toEqual([102]);
    expect(
      (await orderPrintableLabels(db, shipper, { orderId: a.order.id })).map((l) => l.printCount),
    ).toEqual([0, 1]);

    const done = await orderWithLabels("COMPLETED", [301]);
    const again = await createLabelPrint(db, shipper, {
      orderIds: [done.order.id],
      idempotencyKey: key(),
    });
    expect(again.labelCount).toBe(1);
  });

  it("counts a replayed request once", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const a = await orderWithLabels("READY", [101]);
    const input = { orderIds: [a.order.id], idempotencyKey: key() };
    const first = await createLabelPrint(db, shipper, input);
    expect(await createLabelPrint(db, shipper, input)).toEqual(first);
    expect((await db.shippingLabel.findFirstOrThrow()).printCount).toBe(1);
  });

  it("refuses orders that aren't Ready or Completed, and labels that aren't active", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const qa = await orderWithLabels("QA" as "READY", [101]);
    await expect(
      createLabelPrint(db, shipper, { orderIds: [qa.order.id], idempotencyKey: key() }),
    ).rejects.toMatchObject({ messageKey: "errors.shipping.notPrintable" });

    const ready = await orderWithLabels("READY", [101]);
    await db.shippingLabel.update({
      where: { id: ready.labels[0]?.id },
      data: { status: "VOIDED" },
    });
    await expect(
      createLabelPrint(db, shipper, {
        labelIds: [ready.labels[0]?.id as string],
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ messageKey: "errors.shipping.notPrintable" });
    await expect(
      createLabelPrint(db, shipper, { orderIds: [ready.order.id], idempotencyKey: key() }),
    ).rejects.toMatchObject({ messageKey: "errors.shipping.notPrintable" });
  });

  it("allows QA and Admin; refuses a Picker", async () => {
    const a = await orderWithLabels("READY", [101]);
    for (const role of ["QA", "ADMIN"] as const) {
      const actor = await createActor(db, [role]);
      await expect(
        createLabelPrint(db, actor, { orderIds: [a.order.id], idempotencyKey: key() }),
      ).resolves.toMatchObject({ labelCount: 1 });
    }
    const picker = await createActor(db, ["PICKER"]);
    await expect(
      createLabelPrint(db, picker, { orderIds: [a.order.id], idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(
      await orderPrintableLabels(db, await createActor(db, ["SHIPPER"]), { orderId: a.order.id }),
    ).toHaveLength(1);
    await expect(orderPrintableLabels(db, picker, { orderId: a.order.id })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("takes exactly one of orderIds and labelIds", () => {
    const id = crypto.randomUUID();
    const base = { idempotencyKey: "abcdefgh" };
    expect(CreateLabelPrintInput.safeParse({ ...base }).success).toBe(false);
    expect(
      CreateLabelPrintInput.safeParse({ ...base, orderIds: [id], labelIds: [id] }).success,
    ).toBe(false);
    expect(CreateLabelPrintInput.safeParse({ ...base, orderIds: [id] }).success).toBe(true);
  });
});

describe("labelPrintPdf", () => {
  it("is 404 for someone else's print and for one over 24 hours old", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const other = await createActor(db, ["SHIPPER"]);
    const a = await orderWithLabels("READY", [101]);
    const now = new Date();
    const { printId } = await createLabelPrint(
      db,
      shipper,
      { orderIds: [a.order.id], idempotencyKey: key() },
      { now },
    );
    await expect(labelPrintPdf(db, other, storage, printId, { now })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    const late = new Date(now.getTime() + PRINT_TTL_MS + 1000);
    await expect(labelPrintPdf(db, shipper, storage, printId, { now: late })).rejects.toMatchObject(
      {
        kind: "NOT_FOUND",
      },
    );
    await expect(
      labelPrintPdf(db, shipper, storage, crypto.randomUUID(), { now }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(labelPrintPdf(db, shipper, storage, printId, { now })).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });
});

describe("Ready queue print columns", () => {
  it("shows packages, service and Not printed / Partly printed / Printed N×", async () => {
    const { listQueue } = await import("../workflow/queries");
    const shipper = await createActor(db, ["SHIPPER"]);
    const a = await orderWithLabels("READY", [101, 102]);
    const row = async () =>
      (await listQueue(db, shipper, { stage: "READY" })).rows.find((r) => r.id === a.order.id);

    expect(await row()).toMatchObject({
      packageCount: 2,
      shippingSummary: "usps_ground_advantage",
      printState: { kind: "none" },
    });
    await createLabelPrint(db, shipper, {
      labelIds: [a.labels[0]?.id as string],
      idempotencyKey: key(),
    });
    expect((await row())?.printState).toEqual({ kind: "partial" });
    await createLabelPrint(db, shipper, { orderIds: [a.order.id], idempotencyKey: key() });
    expect((await row())?.printState).toEqual({ kind: "printed", times: 1 });
    await createLabelPrint(db, shipper, { orderIds: [a.order.id], idempotencyKey: key() });
    expect((await row())?.printState).toEqual({ kind: "printed", times: 2 });
  });
});
