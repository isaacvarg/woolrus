import type { Db } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fullActivity } from "../../../test/activity";
import { createActor, resetDb, testDb } from "../../../test/db";
import { createOrder, type LineSpec } from "../../../test/factories";
import { finishBatch, removeFromBatch } from "../../picking/batch-complete";
import { createBatch } from "../../picking/batches";
import { linkBarcode } from "../../picking/link-barcode";
import { scan } from "../../picking/scan";
import { markOutOfStock, pickLine, substitute, unpickLine } from "../../picking/service";
import { actionMessageKey, actionRegistry } from "./index";

// SPEC-order-activity: picking's entries in an order's timeline (#199).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const at = (min: number) => ({ now: minutesAgo(30 - min) });

async function picking(lines: LineSpec[], roles: Parameters<typeof createActor>[1] = ["PICKER"]) {
  const picker = await createActor(db, roles);
  const built = await createOrder(db, {
    status: "PICKING",
    version: 2,
    claimedById: picker.userId,
    claimedAt: new Date(),
    lines,
  });
  return { picker, ...built };
}

const feed = async (orderId: string) => {
  const reader = await createActor(db, ["PICKER"]);
  return (await fullActivity(db, reader, { id: orderId })).entries;
};

describe("picking in the timeline", () => {
  it.each(["en", "es"] as const)("words every Picking action in %s", (locale) => {
    const action = messages[locale].activity.action as Record<string, string | undefined>;
    const missing = Object.entries(actionRegistry)
      .filter(([, spec]) => spec.category === "picking")
      .map(([name]) => name)
      .filter((name) => !action[actionMessageKey(name).slice("activity.action.".length)]);
    expect(missing).toEqual([]);
  });

  it("shows picks, unpicks, out of stock and substitutions with line and quantity", async () => {
    const { picker, order, items } = await picking([
      { name: "Lavender soap", quantity: 3 },
      { name: "Rose lotion", quantity: 2 },
      { name: "Mint balm", quantity: 4 },
    ]);
    const [soap, lotion, balm] = items.map((i) => i.id) as [string, string, string];

    await pickLine(db, picker, { itemId: soap, quantity: 2 }, at(1));
    await unpickLine(db, picker, { itemId: soap }, at(2));
    await substitute(
      db,
      picker,
      { itemId: lotion, substitute: "Rose lotion 16 oz", idempotencyKey: "sub-1" },
      at(3),
    );
    await markOutOfStock(
      db,
      picker,
      { itemId: balm, foundQuantity: 1, note: "Only one on the shelf", idempotencyKey: "oos-1" },
      at(4),
    );

    const rows = await db.auditEvent.findMany({ where: { action: { startsWith: "pick." } } });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.orderId === order.id)).toBe(true);

    const entries = (await feed(order.id)).filter((e) => e.category === "picking");
    expect(entries.map((e) => [e.action, e.target, e.params])).toEqual([
      [
        "pick.markOutOfStock",
        { kind: "line", name: "Mint balm" },
        { line: "Mint balm", quantity: 1 },
      ],
      [
        "pick.substitute",
        { kind: "line", name: "Rose lotion" },
        { line: "Rose lotion", quantity: 2 },
      ],
      [
        "pick.unpickLine",
        { kind: "line", name: "Lavender soap" },
        { line: "Lavender soap", quantity: 2 },
      ],
      [
        "pick.pickLine",
        { kind: "line", name: "Lavender soap" },
        { line: "Lavender soap", quantity: 2 },
      ],
    ]);
  });

  it("groups a run of scans on one line into one entry", async () => {
    const { picker, order } = await picking([{ name: "Lavender soap", sku: "LAV-8", quantity: 3 }]);

    for (const min of [1, 2, 3]) {
      await scan(
        db,
        picker,
        { orderId: order.id, code: "LAV-8", scanId: crypto.randomUUID() },
        at(min),
      );
    }

    const entries = (await feed(order.id)).filter((e) => e.action === "pick.scan");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      count: 3,
      target: { kind: "line", name: "Lavender soap" },
      params: { line: "Lavender soap", quantity: 3 },
    });
    expect(entries[0]?.members.map((m) => m.params.quantity)).toEqual([3, 2, 1]);
  });

  it("writes one batch row per order: joining, leaving and finishing", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const a = await createOrder(db, { orderedAt: minutesAgo(50) });
    const b = await createOrder(db, { orderedAt: minutesAgo(40) });
    const c = await createOrder(db, { orderedAt: minutesAgo(30) });
    const batch = await createBatch(db, picker, {
      idempotencyKey: "batch-1",
      orders: [a, b, c].map(({ order }) => ({ id: order.id, expectedVersion: order.version })),
    });
    await removeFromBatch(db, picker, { id: batch.id, orderId: c.order.id });
    await finishBatch(db, picker, { id: batch.id });

    const created = await db.auditEvent.findMany({ where: { action: "pickBatch.create" } });
    expect(created.map((r) => r.orderId).sort()).toEqual(
      [a, b, c].map(({ order }) => order.id).sort(),
    );
    const finished = await db.auditEvent.findMany({ where: { action: "pickBatch.finish" } });
    expect(finished.map((r) => r.orderId).sort()).toEqual(
      [a, b].map(({ order }) => order.id).sort(),
    );

    const ofA = (await feed(a.order.id)).filter((e) => e.category === "picking");
    expect(ofA.map((e) => [e.action, e.params])).toEqual([
      ["pickBatch.finish", { number: batch.number }],
      ["pickBatch.create", { number: batch.number, orders: 3 }],
    ]);
    const ofC = (await feed(c.order.id)).filter((e) => e.category === "picking");
    expect(ofC.map((e) => [e.action, e.params])).toEqual([
      ["pickBatch.removeOrder", { number: batch.number }],
      ["pickBatch.create", { number: batch.number, orders: 3 }],
    ]);
  });

  it("shows a barcode linked from the pick screen on the line", async () => {
    const { picker, order, items } = await picking(
      [{ name: "Lavender soap", barcode: "OLD" }],
      ["ADMIN"],
    );

    await linkBarcode(db, picker, { orderItemId: items[0]?.id as string, code: "0042" });

    const [row] = await db.auditEvent.findMany({ where: { action: "product.linkBarcode" } });
    expect(row?.orderId).toBe(order.id);
    const entries = (await feed(order.id)).filter((e) => e.action === "product.linkBarcode");
    expect(entries).toMatchObject([
      {
        category: "picking",
        target: { kind: "line", name: "Lavender soap" },
        params: { line: "Lavender soap", barcode: "0042" },
      },
    ]);
  });
});
