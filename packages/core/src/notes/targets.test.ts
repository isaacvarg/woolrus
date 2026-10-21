import type { CreateNoteInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { getOrder, listOrders, listQueue } from "../workflow/queries";
import { createNote, deleteNote, listNotes } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let picker: UserActor;
beforeEach(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
});

let keySeq = 0;
function input(
  orderId: string,
  target: CreateNoteInput["target"],
  content = "Box was crushed",
): CreateNoteInput {
  keySeq += 1;
  return {
    idempotencyKey: `target-key-${keySeq}`,
    orderId,
    content,
    visibility: "INTERNAL",
    target,
  };
}

async function createIssue(orderId: string, description = "Jar arrived cracked") {
  return db.qualityIssue.create({
    data: {
      orderId,
      type: "DAMAGED_ITEM",
      severity: "MAJOR",
      description,
      discoveredStage: "QA",
    },
  });
}

/** A client that counts every statement it sends, raw queries included. */
function countingDb(): { db: DbTx; count: () => number } {
  let n = 0;
  const counted = db.$extends({
    query: {
      async $allOperations({ args, query }) {
        n += 1;
        return query(args);
      },
    },
  });
  return { db: counted as unknown as DbTx, count: () => n };
}

describe("note targets", () => {
  it("creates notes on the order, a line, a package and a quality issue, each with its label", async () => {
    const { order, items, packages } = await createOrder(db, {
      number: "5001",
      lines: [{ name: "Lavender soap", quantity: 2 }],
      packages: [{ items: [{ line: 0, quantity: 2 }] }],
    });
    const issue = await createIssue(order.id);
    const [item] = items;
    const [pkg] = packages;
    if (!item || !pkg) throw new Error("fixture");

    const onOrder = await createNote(db, picker, input(order.id, { kind: "order" }));
    const onItem = await createNote(db, picker, input(order.id, { kind: "item", id: item.id }));
    const onPackage = await createNote(
      db,
      picker,
      input(order.id, { kind: "package", id: pkg.id }),
    );
    const onIssue = await createNote(db, picker, input(order.id, { kind: "issue", id: issue.id }));

    expect(onOrder.target).toEqual({ kind: "order", id: order.id, label: "5001" });
    expect(onItem.target).toEqual({ kind: "item", id: item.id, label: "Lavender soap ×2" });
    expect(onPackage.target).toEqual({ kind: "package", id: pkg.id, label: "1" });
    expect(onIssue.target).toEqual({ kind: "issue", id: issue.id, label: "Jar arrived cracked" });

    const listed = await listNotes(db, picker, { orderId: order.id });
    expect(listed.map((n) => n.target.kind)).toEqual(["order", "item", "package", "issue"]);

    const row = await db.note.findUniqueOrThrow({ where: { id: onItem.id } });
    expect(row).toMatchObject({ orderItemId: item.id, packageId: null, qualityIssueId: null });
  });

  it("defaults to the order when no target is given", async () => {
    const { order } = await createOrder(db);
    const { target: _, ...withoutTarget } = input(order.id, { kind: "order" });
    const note = await createNote(db, picker, withoutTarget);
    expect(note.target.kind).toBe("order");
  });

  it("cuts a long issue description in the label", async () => {
    const { order } = await createOrder(db);
    const issue = await createIssue(order.id, "x".repeat(200));
    const note = await createNote(db, picker, input(order.id, { kind: "issue", id: issue.id }));
    expect(note.target.label).toHaveLength(80);
    expect(note.target.label.endsWith("…")).toBe(true);
  });

  it("refuses a target that belongs to another order, or doesn't exist", async () => {
    const { order } = await createOrder(db);
    const other = await createOrder(db, { packages: [{}] });
    const otherIssue = await createIssue(other.order.id);
    const [otherItem] = other.items;
    const [otherPackage] = other.packages;
    if (!otherItem || !otherPackage) throw new Error("fixture");

    for (const target of [
      { kind: "item", id: otherItem.id },
      { kind: "package", id: otherPackage.id },
      { kind: "issue", id: otherIssue.id },
      { kind: "item", id: crypto.randomUUID() },
    ] as const) {
      await expect(createNote(db, picker, input(order.id, target))).rejects.toMatchObject({
        kind: "BAD_REQUEST",
        messageKey: "errors.notes.targetMismatch",
      });
    }
    expect(await db.note.count()).toBe(0);
  });
});

describe("note counts", () => {
  it("counts every note of the order on queue and All Orders rows", async () => {
    const { order, items } = await createOrder(db, { number: "6001" });
    await createOrder(db, { number: "6002" });
    const [item] = items;
    if (!item) throw new Error("fixture");
    await createNote(db, picker, input(order.id, { kind: "order" }));
    const second = await createNote(db, picker, input(order.id, { kind: "item", id: item.id }));

    const counts = (rows: { number: string; noteCount: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.number, r.noteCount]));
    expect(counts((await listQueue(db, picker, { stage: "PENDING" })).rows)).toEqual({
      "6001": 2,
      "6002": 0,
    });
    expect(counts((await listOrders(db, picker, {})).rows)).toEqual({ "6001": 2, "6002": 0 });

    await deleteNote(db, picker, { id: second.id });
    expect(counts((await listOrders(db, picker, {})).rows)).toEqual({ "6001": 1, "6002": 0 });
  });

  it("counts notes on each line and package in the order detail", async () => {
    const { order, items, packages } = await createOrder(db, {
      lines: [{}, {}],
      packages: [{}, {}],
    });
    const [first, second] = items;
    const [box1, box2] = packages;
    if (!first || !second || !box1 || !box2) throw new Error("fixture");
    await createNote(db, picker, input(order.id, { kind: "order" }));
    await createNote(db, picker, input(order.id, { kind: "item", id: first.id }));
    await createNote(db, picker, input(order.id, { kind: "item", id: first.id }));
    await createNote(db, picker, input(order.id, { kind: "package", id: box2.id }));

    const view = await getOrder(db, picker, { id: order.id });
    expect(view.lines.map((l) => [l.id, l.noteCount])).toEqual([
      [first.id, 2],
      [second.id, 0],
    ]);
    expect(view.packages.map((p) => [p.id, p.noteCount])).toEqual([
      [box1.id, 0],
      [box2.id, 1],
    ]);
  });

  it("runs a constant number of queries for a page, however many rows it has", async () => {
    const queries = async (orders: number) => {
      await resetDb(db);
      for (let i = 0; i < orders; i++) {
        const { order } = await createOrder(db, { lines: [], number: String(7000 + i) });
        await db.note.create({ data: { orderId: order.id, content: "n" } });
      }
      const queue = countingDb();
      const page = await listQueue(queue.db, picker, { stage: "PENDING", limit: 100 });
      expect(page.rows).toHaveLength(orders);
      expect(page.rows.every((r) => r.noteCount === 1)).toBe(true);
      const all = countingDb();
      const list = await listOrders(all.db, picker, { pageSize: 100 });
      expect(list.rows.every((r) => r.noteCount === 1)).toBe(true);
      return [queue.count(), all.count()];
    };

    const small = await queries(2);
    const large = await queries(100);
    expect(small[0]).toBeGreaterThan(0);
    expect(large).toEqual(small);
  }, 60_000);
});
