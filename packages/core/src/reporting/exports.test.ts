import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { type CsvCell, csvStream } from "../csv";
import type { CsvExport } from "../rate-lab/exports";
import {
  capRows,
  EXPORT_ROW_CAP,
  isoInZone,
  issuesCsv,
  orderItemsCsv,
  ordersCsv,
  voidsCsv,
} from "./exports";

// SPEC-reporting "CSV exports" (criteria 6, 7): the All orders, Issues and Voids lists and the
// order-items export. Same filters as the screens, no customer contact columns, times in the
// requested zone, headers in the viewer's locale, CSV injection defused, and the 100,000-row cap.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const en = { locale: "en", timeZone: "America/Chicago" } as const;
const now = new Date("2026-11-03T18:00:00Z");

async function lines(csv: CsvExport): Promise<string[]> {
  const bytes = new Uint8Array(await new Response(csvStream(csv.header, csv.rows)).arrayBuffer());
  return new TextDecoder().decode(bytes.slice(3)).split("\r\n").slice(0, -1);
}

async function user(name: string) {
  return db.user.create({ data: { name, email: `${crypto.randomUUID()}@example.test` } });
}

describe("isoInZone", () => {
  it("writes ISO 8601 with the zone's offset, across a DST change", () => {
    expect(isoInZone(new Date("2026-11-03T18:00:00.456Z"), "America/Chicago")).toBe(
      "2026-11-03T12:00:00-06:00",
    );
    expect(isoInZone(new Date("2026-07-01T04:30:00Z"), "America/Chicago")).toBe(
      "2026-06-30T23:30:00-05:00",
    );
    expect(isoInZone(new Date("2026-07-01T04:30:00Z"), "Asia/Kolkata")).toBe(
      "2026-07-01T10:00:00+05:30",
    );
    expect(isoInZone(new Date("2026-07-01T04:30:00Z"), "UTC")).toBe("2026-07-01T04:30:00+00:00");
  });
});

describe("capRows", () => {
  async function collect(rows: AsyncIterable<readonly CsvCell[]>) {
    const out: (readonly CsvCell[])[] = [];
    for await (const row of rows) out.push(row);
    return out;
  }
  async function* count(n: number) {
    for (let i = 0; i < n; i++) yield [i];
  }

  it("is 100,000 rows", () => expect(EXPORT_ROW_CAP).toBe(100_000));

  it("passes an export at the cap through untouched", async () => {
    let cut = false;
    const rows = await collect(capRows(count(3), 3, ["cut"], () => (cut = true)));
    expect(rows).toEqual([[0], [1], [2]]);
    expect(cut).toBe(false);
  });

  it("ends a longer export with the cut row and reports it", async () => {
    let cut = false;
    const rows = await collect(
      capRows(count(EXPORT_ROW_CAP + 5), EXPORT_ROW_CAP, ["cut"], () => (cut = true)),
    );
    expect(rows).toHaveLength(EXPORT_ROW_CAP + 1);
    expect(rows.at(-2)).toEqual([EXPORT_ROW_CAP - 1]);
    expect(rows.at(-1)).toEqual(["cut"]);
    expect(cut).toBe(true);
  });
});

describe("ordersCsv", () => {
  it("writes the All orders columns, with the list's filters and sort", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const shipped = await createOrder(db, {
      number: "1001",
      customerName: "=SUM(A1)",
      status: "COMPLETED",
      priority: 2,
      orderedAt: new Date("2026-11-01T05:30:00Z"),
      lines: [
        { quantity: 3, voids: [{ quantity: 1 }, { quantity: 1, undone: true }] },
        { quantity: 1, physical: false },
      ],
      packages: [{ label: "ACTIVE" }, { label: "VOIDED" }],
    });
    await db.order.update({
      where: { id: shipped.order.id },
      data: { createdAt: new Date("2026-11-01T06:00:00Z"), completedAt: now },
    });
    await db.shippingLabel.updateMany({
      where: { packageId: shipped.packages[0]?.id },
      data: { trackingNumber: "1Z999" },
    });
    await db.shippingLabel.updateMany({
      where: { packageId: shipped.packages[1]?.id },
      data: { trackingNumber: "VOIDED-ONE" },
    });
    const purged = await createOrder(db, {
      number: "1002",
      customerName: "Ann Smith",
      status: "PACKING",
      orderedAt: new Date("2026-11-02T05:30:00Z"),
    });
    await db.order.update({
      where: { id: purged.order.id },
      data: { piiRedactedAt: now, createdAt: new Date("2026-11-02T06:00:00Z") },
    });
    // Filtered out by status.
    await createOrder(db, { number: "1003", status: "PENDING" });

    const csv = await ordersCsv(
      db,
      admin,
      { statuses: ["COMPLETED", "PACKING"], sort: "number", dir: "asc", timeZone: en.timeZone },
      { locale: "en", now },
    );
    expect(csv.filename).toBe("woolrus-orders-2026-11-03.csv");
    expect(await lines(csv)).toEqual([
      "Order,Ordered,Imported,Status,Priority,Customer,Items,Units,Shipped at,Tracking",
      "1001,2026-11-01T00:30:00-05:00,2026-11-01T01:00:00-05:00,COMPLETED,2,'=SUM(A1),1,2,2026-11-03T12:00:00-06:00,1Z999",
      "1002,2026-11-01T23:30:00-06:00,2026-11-02T00:00:00-06:00,PACKING,0,,1,1,,",
    ]);
  });

  it("applies the search and writes Spanish headers", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createOrder(db, { number: "2001", customerName: "Maria Lopez" });
    await createOrder(db, { number: "2002", customerName: "John Doe" });
    const csv = await ordersCsv(
      db,
      admin,
      { search: "maria", timeZone: "UTC" },
      { locale: "es", now },
    );
    const [header, ...rows] = await lines(csv);
    expect(header).toBe(
      "Pedido,Fecha del pedido,Importado,Estado,Prioridad,Cliente,Artículos,Unidades,Enviado,Seguimiento",
    );
    expect(rows.map((r) => r.split(",")[0])).toEqual(["2001"]);
  });

  it("ends with the cut row past the cap", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    for (const number of ["1", "2", "3"]) await createOrder(db, { number });
    const csv = await ordersCsv(
      db,
      admin,
      { sort: "number", dir: "asc", timeZone: "UTC" },
      { locale: "en", now, cap: 2 },
    );
    const out = await lines(csv);
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(
      '"Export cut at 2 rows. Narrow the filters, or export in pieces, to get the rest."',
    );
  });
});

describe("issuesCsv", () => {
  it("writes one row per issue the Issues list shows with its filters", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const maria = await user("Maria");
    const ann = await user("Ann");
    const { order } = await createOrder(db, { number: "3001", customerName: "Pat Doe" });
    const issue = (data: object) =>
      db.qualityIssue.create({
        data: {
          orderId: order.id,
          type: "WRONG_ITEM",
          severity: "MAJOR",
          description: "Sent the blue one",
          discoveredStage: "QA",
          ...data,
        },
      });
    await issue({
      originStage: "PICKING",
      responsibleUserId: maria.id,
      reporterId: ann.id,
      customerReported: true,
      createdAt: new Date("2026-11-02T15:00:00Z"),
    });
    await issue({
      status: "RESOLVED",
      resolvedAt: new Date("2026-11-03T15:00:00Z"),
      resolvedById: ann.id,
      description: "@cmd",
      createdAt: new Date("2026-11-01T15:00:00Z"),
    });
    // Filtered out by severity.
    await issue({ severity: "MINOR" });

    const csv = await issuesCsv(
      db,
      admin,
      { severity: "MAJOR", timeZone: en.timeZone },
      { locale: "en", now },
    );
    expect(csv.filename).toBe("woolrus-issues-2026-11-03.csv");
    expect(await lines(csv)).toEqual([
      "Order,Customer,Created,Type,Severity,Status,Discovered stage,Origin stage,Responsible,Reported by,Customer-reported,Description,Resolved at,Resolved by",
      "3001,Pat Doe,2026-11-02T09:00:00-06:00,WRONG_ITEM,MAJOR,OPEN,QA,PICKING,Maria,Ann,yes,Sent the blue one,,",
      "3001,Pat Doe,2026-11-01T09:00:00-06:00,WRONG_ITEM,MAJOR,RESOLVED,QA,,,,no,'@cmd,2026-11-03T09:00:00-06:00,Ann",
    ]);

    const open = await issuesCsv(
      db,
      admin,
      { status: "open", type: "WRONG_ITEM", timeZone: "UTC" },
      { locale: "en", now },
    );
    expect(await lines(open)).toHaveLength(3);
  });
});

describe("voidsCsv", () => {
  it("writes one row per void the Voids list shows with its tab and search", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const maria = await user("Maria");
    const { order, items } = await createOrder(db, {
      number: "4001",
      customerName: "Pat Doe",
      status: "PICKING",
      lines: [{ sku: "MUG-1", name: "Mug, large", quantity: 4 }],
    });
    const item = items[0];
    if (!item) throw new Error("missing line");
    const voidRow = (data: object) =>
      db.itemVoid.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          quantity: 1,
          reason: "Damaged",
          stage: "PICKING",
          ...data,
        },
      });
    await voidRow({ voidedById: maria.id, voidedAt: new Date("2026-11-02T15:00:00Z") });
    await voidRow({
      reason: "Out of stock",
      voidedAt: new Date("2026-11-01T15:00:00Z"),
      resolution: "REFUNDED",
      resolvedAt: new Date("2026-11-02T16:00:00Z"),
      resolvedById: maria.id,
    });
    const other = await createOrder(db, { number: "4002", lines: [{ voids: [{ quantity: 1 }] }] });

    const unresolved = await voidsCsv(
      db,
      admin,
      { search: "4001", timeZone: en.timeZone },
      { locale: "en", now },
    );
    expect(unresolved.filename).toBe("woolrus-voids-2026-11-03.csv");
    expect(await lines(unresolved)).toEqual([
      "Order,Customer,Order status,Voided at,SKU,Product,Quantity,Reason,Stage,Voided by,Resolution,Resolved at,Resolved by,Undone at",
      '4001,Pat Doe,PICKING,2026-11-02T09:00:00-06:00,MUG-1,"Mug, large",1,Damaged,PICKING,Maria,,,,',
    ]);

    const all = await voidsCsv(
      db,
      admin,
      { status: "all", timeZone: "UTC" },
      { locale: "en", now },
    );
    const rows = (await lines(all)).slice(1).map((r) => r.split(",")[0]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows)).toEqual(new Set(["4001", other.order.number]));

    const resolved = await voidsCsv(
      db,
      admin,
      { status: "resolved", timeZone: "UTC" },
      { locale: "en", now },
    );
    expect((await lines(resolved)).slice(1)).toEqual([
      '4001,Pat Doe,PICKING,2026-11-01T15:00:00+00:00,MUG-1,"Mug, large",1,Out of stock,PICKING,,REFUNDED,2026-11-02T16:00:00+00:00,Maria,',
    ]);
  });
});

describe("orderItemsCsv", () => {
  it("writes one row per line on orders imported in the range, in the zone", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const picker = await user("Pia");
    const packer = await user("Paco");
    const qa = await user("Quinn");
    const built = await createOrder(db, {
      number: "5001",
      status: "READY",
      lines: [
        { sku: "MUG-1", name: "Mug", quantity: 3, pickStatus: "PICKED", voids: [{ quantity: 1 }] },
        { sku: "CAP-1", name: "Cap", quantity: 1 },
      ],
      packages: [{ items: [{ line: 0, quantity: 2, verified: true }] }],
    });
    // Imported 22:30 on Nov 1 in Chicago, though Nov 2 in UTC: inside the range.
    await db.order.update({
      where: { id: built.order.id },
      data: { createdAt: new Date("2026-11-02T04:30:00Z") },
    });
    const [mug] = built.items;
    if (!mug) throw new Error("missing line");
    await db.orderItem.update({
      where: { id: mug.id },
      data: { pickedById: picker.id, pickedAt: new Date("2026-11-02T14:00:00Z") },
    });
    await db.packageItem.updateMany({
      where: { orderItemId: mug.id },
      data: {
        packedById: packer.id,
        packedAt: new Date("2026-11-02T15:00:00Z"),
        qaVerifiedById: qa.id,
        qaVerifiedAt: new Date("2026-11-02T16:00:00Z"),
      },
    });
    // Imported Nov 4 local: past the range.
    const late = await createOrder(db, { number: "5002" });
    await db.order.update({
      where: { id: late.order.id },
      data: { createdAt: new Date("2026-11-04T07:00:00Z") },
    });

    const csv = await orderItemsCsv(
      db,
      admin,
      { from: "2026-11-01", to: "2026-11-03", timeZone: en.timeZone },
      { locale: "en", now },
    );
    expect(csv.filename).toBe("woolrus-order-items-2026-11-01-2026-11-03.csv");
    expect(await lines(csv)).toEqual([
      "Order,SKU,Product,Ordered qty,Picked qty,Pick status,Picked by,Picked at,Packed by,Packed at,QA by,QA at,Voided qty",
      "5001,MUG-1,Mug,3,3,PICKED,Pia,2026-11-02T08:00:00-06:00,Paco,2026-11-02T09:00:00-06:00,Quinn,2026-11-02T10:00:00-06:00,1",
      "5001,CAP-1,Cap,1,0,PENDING,,,,,,,0",
    ]);
  });

  it("refuses a range longer than 92 days", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      orderItemsCsv(
        db,
        admin,
        { from: "2026-01-01", to: "2026-06-01", timeZone: "UTC" },
        { locale: "en", now },
      ),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});

describe("every export", () => {
  const exports = {
    orders: (actor: Parameters<typeof ordersCsv>[1]) =>
      ordersCsv(db, actor, { timeZone: "UTC" }, { locale: "en", now }),
    issues: (actor: Parameters<typeof ordersCsv>[1]) =>
      issuesCsv(db, actor, { timeZone: "UTC" }, { locale: "en", now }),
    voids: (actor: Parameters<typeof ordersCsv>[1]) =>
      voidsCsv(db, actor, { timeZone: "UTC" }, { locale: "en", now }),
    orderItems: (actor: Parameters<typeof ordersCsv>[1]) =>
      orderItemsCsv(
        db,
        actor,
        { from: "2026-11-01", to: "2026-11-03", timeZone: "UTC" },
        { locale: "en", now },
      ),
  };

  it.each(Object.entries(exports))("%s needs report.read", async (_, run) => {
    await expect(run(await createActor(db, ["ADMIN"]))).resolves.toMatchObject({
      header: expect.any(Array),
    });
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      await expect(run(await createActor(db, [role]))).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    }
  });

  it.each(Object.entries(exports))("%s has no customer contact column", async (_, run) => {
    const csv = await run(await createActor(db, ["ADMIN"]));
    for (const column of csv.header) expect(column).not.toMatch(/mail|phone|address/i);
  });
});
