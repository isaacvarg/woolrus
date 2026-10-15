import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { Actor } from "../permissions";
import { listQueue, queueCounts } from "./queries";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let picker: Actor;
beforeEach(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const numbers = (page: { rows: { number: string }[] }) => page.rows.map((r) => r.number);

describe("listQueue", () => {
  it("needs order.read", async () => {
    const nobody = await createActor(db, []);
    await expect(listQueue(db, nobody, { stage: "PENDING" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("lists one stage, highest priority first, then oldest", async () => {
    await createOrder(db, { number: "1001", orderedAt: minutesAgo(10) });
    await createOrder(db, { number: "1002", orderedAt: minutesAgo(30) });
    await createOrder(db, { number: "1003", orderedAt: minutesAgo(5), priority: 2 });
    await createOrder(db, { number: "1004", orderedAt: minutesAgo(1), priority: 1 });
    await createOrder(db, { number: "1005", status: "PICKING" });
    await createOrder(db, { number: "1006", status: "ON_HOLD", heldFromStatus: "PENDING" });

    expect(numbers(await listQueue(db, picker, { stage: "PENDING" }))).toEqual([
      "1003",
      "1004",
      "1002",
      "1001",
    ]);
  });

  it("pages with a cursor, without gaps or repeats, even on equal sort keys", async () => {
    const at = minutesAgo(10);
    for (const n of ["2001", "2002", "2003", "2004", "2005"]) {
      await createOrder(db, { number: n, orderedAt: at, priority: n === "2005" ? 1 : 0 });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listQueue(db, picker, { stage: "PENDING", limit: 2, cursor });
      seen.push(...numbers(page));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen[0]).toBe("2005");
    expect([...seen].sort()).toEqual(["2001", "2002", "2003", "2004", "2005"]);
  });

  it("returns no cursor when the page isn't full", async () => {
    await createOrder(db);
    expect((await listQueue(db, picker, { stage: "PENDING", limit: 2 })).nextCursor).toBeNull();
  });

  it("refuses a cursor it didn't issue", async () => {
    await expect(
      listQueue(db, picker, { stage: "PENDING", cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", fields: { cursor: "errors.field.invalid" } });
  });

  it("searches by number prefix and by part of the customer's name", async () => {
    await createOrder(db, { number: "51200", customerName: "Ana López" });
    await createOrder(db, { number: "51299", customerName: "Bruno Díaz" });
    await createOrder(db, { number: "40512", customerName: "Carla Ruiz" });

    const search = async (text: string) =>
      numbers(await listQueue(db, picker, { stage: "PENDING", search: text })).sort();

    expect(await search("512")).toEqual(["51200", "51299"]);
    expect(await search("#5120")).toEqual(["51200"]);
    expect(await search("lópez")).toEqual(["51200"]);
    expect(await search("RUIZ")).toEqual(["40512"]);
    expect(await search("%")).toEqual([]);
    expect(await search("  ")).toEqual(["40512", "51200", "51299"]);
  });

  it("counts active units of physical lines", async () => {
    const { order } = await createOrder(db, {
      lines: [
        { quantity: 3, voids: [{ quantity: 1 }, { quantity: 2, undone: true }] },
        { quantity: 2, noProduct: true },
        { quantity: 1, name: "Rush Order", physical: false },
        { quantity: 1, voids: [{ quantity: 1 }] },
      ],
    });

    const [row] = (await listQueue(db, picker, { stage: "PENDING" })).rows;
    expect(row).toMatchObject({ id: order.id, itemCount: 4 });
  });

  it("flags time in stage past the stage's SLA", async () => {
    await db.settings.upsert({
      where: { id: 1 },
      create: { id: 1, stageSlaMinutes: { PENDING: 60 } },
      update: { stageSlaMinutes: { PENDING: 60 } },
    });
    const late = await createOrder(db, { number: "3001", statusChangedAt: minutesAgo(61) });
    await createOrder(db, { number: "3002", statusChangedAt: minutesAgo(59) });
    await createOrder(db, { number: "3003", status: "PICKING", statusChangedAt: minutesAgo(600) });

    const pending = (await listQueue(db, picker, { stage: "PENDING" })).rows;
    expect(pending.find((r) => r.slaBreached)?.id).toBe(late.order.id);
    expect(pending.filter((r) => r.slaBreached)).toHaveLength(1);
    expect(pending.find((r) => r.number === "3001")?.stageEnteredAt).toEqual(
      late.order.statusChangedAt,
    );

    const picking = (await listQueue(db, picker, { stage: "PICKING" })).rows;
    expect(picking[0]?.slaBreached).toBe(false);
  });

  it("shows live claims only, with the holder's name", async () => {
    await db.user.update({ where: { id: picker.userId }, data: { name: "Ana" } });
    const at = minutesAgo(5);
    await createOrder(db, {
      number: "4001",
      status: "PICKING",
      claimedById: picker.userId,
      claimedAt: at,
    });
    await createOrder(db, {
      number: "4002",
      status: "PICKING",
      claimedById: picker.userId,
      claimedAt: minutesAgo(31),
    });

    const rows = (await listQueue(db, picker, { stage: "PICKING" })).rows;
    expect(rows.find((r) => r.number === "4001")?.claim).toEqual({
      userId: picker.userId,
      userName: "Ana",
      at,
    });
    expect(rows.find((r) => r.number === "4002")?.claim).toBeNull();
  });

  it("carries the external-change flag, hold details and version", async () => {
    const { order } = await createOrder(db, {
      status: "ON_HOLD",
      heldFromStatus: "PACKING",
      holdReason: "Customer called",
      version: 4,
    });
    await db.order.update({
      where: { id: order.id },
      data: { externalChangeDetectedAt: new Date() },
    });

    const [row] = (await listQueue(db, picker, { stage: "ON_HOLD" })).rows;
    expect(row).toMatchObject({
      externalChange: true,
      holdReason: "Customer called",
      heldFromStatus: "PACKING",
      version: 4,
    });
  });
});

describe("queueCounts", () => {
  it("counts every queue, zeros included, and nothing finished", async () => {
    await createOrder(db);
    await createOrder(db);
    await createOrder(db, { status: "QA" });
    await createOrder(db, { status: "ON_HOLD", heldFromStatus: "QA" });
    await createOrder(db, { status: "COMPLETED" });
    await createOrder(db, { status: "CANCELLED" });

    expect(await queueCounts(db, picker)).toEqual({
      PENDING: 2,
      PICKING: 0,
      PACKING: 0,
      QA: 1,
      READY: 0,
      ON_HOLD: 1,
    });
  });

  it("needs order.read", async () => {
    const nobody = await createActor(db, []);
    await expect(queueCounts(db, nobody)).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});
