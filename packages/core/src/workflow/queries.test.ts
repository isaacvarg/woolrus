import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { systemActor, type UserActor } from "../permissions";
import { claim, takeOver } from "./claims";
import { getOrder, getOrderHistory, listOrders, listQueue, queueCounts } from "./queries";
import { beginPicking, hold, transition } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let picker: UserActor;
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
    // Well-formed, but a priority Postgres can't hold: a 400, not a database error.
    const outOfRange = Buffer.from(
      JSON.stringify([1e300, new Date().toISOString(), crypto.randomUUID()]),
    ).toString("base64url");
    for (const cursor of ["not-a-cursor", outOfRange]) {
      await expect(listQueue(db, picker, { stage: "PENDING", cursor })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
        fields: { cursor: "errors.field.invalid" },
      });
    }
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

  it("names a holder who has no name yet by their email", async () => {
    // Magic-link sign-up creates users with an empty name.
    const user = await db.user.update({ where: { id: picker.userId }, data: { name: " " } });
    await createOrder(db, { number: "4101", status: "PICKING", claimedById: picker.userId });

    const [row] = (await listQueue(db, picker, { stage: "PICKING" })).rows;
    expect(row?.claim?.userName).toBe(user.email);
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

describe("getOrder", () => {
  it("needs order.read and an existing order", async () => {
    const { order } = await createOrder(db);
    const nobody = await createActor(db, []);
    await expect(getOrder(db, nobody, { id: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(
      getOrder(db, picker, { id: "0199e6a0-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("returns the header, addresses, lines with active quantity and packages", async () => {
    const { order, items } = await createOrder(db, {
      status: "PACKING",
      number: "7001",
      lines: [
        { name: "Wool", quantity: 3, pickStatus: "PICKED", voids: [{ quantity: 1 }] },
        { name: "Rush Order", physical: false },
      ],
      packages: [{ items: [{ line: 0, quantity: 2 }], weightOz: 12.5, label: "ACTIVE" }],
    });

    const view = await getOrder(db, picker, { id: order.id });

    expect(view).toMatchObject({
      id: order.id,
      number: "7001",
      status: "PACKING",
      customerEmail: "customer@example.test",
      shippingAddress: { name: "Test Customer", city: "Austin", postalCode: "78701" },
      version: 1,
    });
    expect(view.lines).toEqual([
      expect.objectContaining({
        id: items[0]?.id,
        name: "Wool",
        quantity: 3,
        activeQuantity: 2,
        physical: true,
        pickStatus: "PICKED",
        pickedQuantity: 3,
      }),
      expect.objectContaining({ name: "Rush Order", activeQuantity: 1, physical: false }),
    ]);
    expect(view.packages).toEqual([
      expect.objectContaining({ number: 1, weightOz: 12.5, units: 2, liveLabel: true }),
    ]);
    expect(view.packages[0]?.boxName).toMatch(/^Box /);
  });

  it("treats a line without a product row as physical", async () => {
    const { order } = await createOrder(db, { lines: [{ noProduct: true }] });
    expect((await getOrder(db, picker, { id: order.id })).lines[0]?.physical).toBe(true);
  });

  it("computes allowed actions from the caller's roles and the live claim", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { order } = await createOrder(db, {
      status: "PACKING",
      claimedById: packer.userId,
      claimedAt: minutesAgo(5),
    });

    expect((await getOrder(db, packer, { id: order.id })).allowedActions.sort()).toEqual(
      ["completePacking", "hold", "release"].sort(),
    );
    const otherPacker = await createActor(db, ["PACKER"]);
    expect((await getOrder(db, otherPacker, { id: order.id })).allowedActions.sort()).toEqual(
      ["hold", "takeOver"].sort(),
    );
  });

  it("names a holder who has no name yet by their email", async () => {
    const user = await db.user.update({ where: { id: picker.userId }, data: { name: "" } });
    const { order } = await createOrder(db, { claimedById: picker.userId });

    expect((await getOrder(db, picker, { id: order.id })).claim?.userName).toBe(user.email);
  });

  it("treats an expired claim as free", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { order } = await createOrder(db, {
      status: "PACKING",
      claimedById: picker.userId,
      claimedAt: minutesAgo(31),
    });

    const view = await getOrder(db, packer, { id: order.id });
    expect(view.claim).toBeNull();
    expect(view.allowedActions.sort()).toEqual(["claim", "hold"]);
  });
});

describe("getOrderHistory", () => {
  it("lists stage changes and claim moves newest first, with actor and station names", async () => {
    const station = await db.station.create({ data: { name: "Tablet 3", tokenHash: "h-3" } });
    await db.user.update({ where: { id: picker.userId }, data: { name: "Ana" } });
    const atStation = { ...picker, stationId: station.id };
    const bruno = await createActor(db, ["PICKER"]);
    await db.user.update({ where: { id: bruno.userId }, data: { name: "Bruno" } });
    const { order } = await createOrder(db);

    const t = (min: number) => ({ now: new Date(Date.now() - (10 - min) * 60_000) });
    await claim(db, atStation, { orderId: order.id, expectedVersion: 1 }, t(1));
    await takeOver(db, bruno, { orderId: order.id, expectedVersion: 2, confirm: true }, t(2));
    await beginPicking(db, bruno, { orderId: order.id, expectedVersion: 3 }, t(3));
    await hold(db, atStation, { orderId: order.id, expectedVersion: 4, reason: "Address" }, t(4));

    const history = await getOrderHistory(db, picker, { id: order.id });

    expect(history.map((h) => [h.type, h.actorName])).toEqual([
      ["stage", "Ana"],
      ["stage", "Bruno"],
      ["takeOver", "Bruno"],
      ["claim", "Ana"],
    ]);
    expect(history[0]).toMatchObject({
      fromStatus: "PICKING",
      toStatus: "ON_HOLD",
      reason: "Address",
      stationName: "Tablet 3",
    });
    expect(history[2]).toMatchObject({
      fromStatus: null,
      toStatus: null,
      previousHolderName: "Ana",
      stationName: null,
    });
    expect(history[3]?.stationName).toBe("Tablet 3");
  });

  it("names people who have no name yet by their email", async () => {
    const ana = await db.user.update({ where: { id: picker.userId }, data: { name: "" } });
    const bruno = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    const t = (min: number) => ({ now: new Date(Date.now() - (10 - min) * 60_000) });
    await claim(db, picker, { orderId: order.id, expectedVersion: 1 }, t(1));
    await takeOver(db, bruno, { orderId: order.id, expectedVersion: 2, confirm: true }, t(2));

    const history = await getOrderHistory(db, picker, { id: order.id });
    expect(history.map((h) => h.actorName)).toEqual(["Test User", ana.email]);
    expect(history[0]?.previousHolderName).toBe(ana.email);
  });

  it("leaves out audit rows that aren't about claims, and other orders", async () => {
    const { order } = await createOrder(db);
    const { order: other } = await createOrder(db);
    await db.auditEvent.create({
      data: { entityType: "Order", entityId: order.id, action: "order.somethingElse" },
    });
    await claim(db, picker, { orderId: other.id, expectedVersion: 1 });

    expect(await getOrderHistory(db, picker, { id: order.id })).toEqual([]);
  });

  it("needs order.read and an existing order", async () => {
    const nobody = await createActor(db, []);
    const { order } = await createOrder(db);
    await expect(getOrderHistory(db, nobody, { id: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(
      getOrderHistory(db, picker, { id: "0199e6a0-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("marks store-sync moves as the system's, and people's as not", async () => {
    const { order } = await createOrder(db);
    await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });
    await db.$transaction((tx) =>
      transition(tx, systemActor, {
        orderId: order.id,
        expectedVersion: 2,
        to: "ON_HOLD",
        kind: "hold",
        reason: "Cancelled in store",
      }),
    );

    const history = await getOrderHistory(db, picker, { id: order.id });
    expect(history.map((h) => [h.bySystem, h.actorName])).toEqual([
      [true, null],
      [false, "Test User"],
    ]);
  });
});

describe("listOrders", () => {
  const list = (input: Parameters<typeof listOrders>[2] = {}) => listOrders(db, picker, input);

  it("needs order.read", async () => {
    const nobody = await createActor(db, []);
    await expect(listOrders(db, nobody, {})).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("lists every status, newest first by default, with a total", async () => {
    await createOrder(db, { number: "100", orderedAt: minutesAgo(30), status: "COMPLETED" });
    await createOrder(db, { number: "101", orderedAt: minutesAgo(20), status: "CANCELLED" });
    await createOrder(db, { number: "102", orderedAt: minutesAgo(10) });

    const page = await list();
    expect(numbers(page)).toEqual(["102", "101", "100"]);
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(page.rows[1]).toMatchObject({ status: "CANCELLED", externalChange: false });
  });

  it("filters by status and searches like the queues", async () => {
    await createOrder(db, { number: "51200", customerName: "Ana López", status: "QA" });
    await createOrder(db, { number: "51299", customerName: "Bruno Díaz", status: "READY" });
    await createOrder(db, { number: "40512", customerName: "Carla Ruiz", status: "QA" });

    expect(numbers(await list({ statuses: ["QA"], sort: "number", dir: "asc" }))).toEqual([
      "40512",
      "51200",
    ]);
    expect(numbers(await list({ search: "#512", sort: "number", dir: "asc" }))).toEqual([
      "51200",
      "51299",
    ]);
    const filtered = await list({ search: "lópez", statuses: ["QA", "READY"] });
    expect(numbers(filtered)).toEqual(["51200"]);
    expect(filtered.total).toBe(1);
    expect((await list({ search: "%" })).total).toBe(0);
  });

  it("sorts order numbers numerically, and by each column in either direction", async () => {
    await createOrder(db, { number: "999", customerName: "Carla", priority: 0, status: "QA" });
    await createOrder(db, { number: "1000", customerName: "ana", priority: 2 });
    await createOrder(db, { number: "1001", customerName: "Bruno", priority: 1, status: "READY" });

    expect(numbers(await list({ sort: "number", dir: "asc" }))).toEqual(["999", "1000", "1001"]);
    expect(numbers(await list({ sort: "number", dir: "desc" }))).toEqual(["1001", "1000", "999"]);
    expect(numbers(await list({ sort: "customer", dir: "asc" }))).toEqual(["1000", "1001", "999"]);
    expect(numbers(await list({ sort: "priority", dir: "desc" }))).toEqual(["1000", "1001", "999"]);
    // Workflow order, not alphabetical.
    expect(numbers(await list({ sort: "status", dir: "asc" }))).toEqual(["1000", "999", "1001"]);
  });

  it("pages by offset, keeping the total", async () => {
    for (let i = 0; i < 5; i++) {
      await createOrder(db, { number: String(200 + i), orderedAt: minutesAgo(10 - i) });
    }

    const second = await list({ sort: "number", dir: "asc", page: 2, pageSize: 2 });
    expect(numbers(second)).toEqual(["202", "203"]);
    expect(second.total).toBe(5);
    const beyond = await list({ page: 9, pageSize: 2 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(5);
  });
});
