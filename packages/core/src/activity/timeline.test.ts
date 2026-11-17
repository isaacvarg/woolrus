import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { systemActor, type UserActor } from "../permissions";
import { claim, takeOver } from "../workflow/claims";
import { beginPicking, hold, transition } from "../workflow/service";
import { getOrderActivity, TIMELINE_ROW_CAP } from "./timeline";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let picker: UserActor;
beforeEach(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const t = (min: number) => ({ now: minutesAgo(10 - min) });

describe("getOrderActivity", () => {
  it("needs order.read and an existing order", async () => {
    const nobody = await createActor(db, []);
    const { order } = await createOrder(db);
    await expect(getOrderActivity(db, nobody, { id: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(
      getOrderActivity(db, picker, { id: "0199e6a0-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("merges stage events and claim rows newest first, with people, stations and params", async () => {
    const station = await db.station.create({ data: { name: "Tablet 3", tokenHash: "h-3" } });
    await db.user.update({ where: { id: picker.userId }, data: { name: "Ana" } });
    const atStation = { ...picker, stationId: station.id };
    const bruno = await createActor(db, ["PICKER"]);
    await db.user.update({ where: { id: bruno.userId }, data: { name: "Bruno" } });
    const { order } = await createOrder(db);

    await claim(db, atStation, { orderId: order.id, expectedVersion: 1 }, t(1));
    await takeOver(db, bruno, { orderId: order.id, expectedVersion: 2, confirm: true }, t(2));
    await beginPicking(db, bruno, { orderId: order.id, expectedVersion: 3 }, t(3));
    await hold(db, atStation, { orderId: order.id, expectedVersion: 4, reason: "Address" }, t(4));

    const { entries, truncated } = await getOrderActivity(db, picker, { id: order.id });

    expect(truncated).toBe(false);
    // A move writes a stage event and an audit row; only the stage event is shown.
    expect(entries.map((e) => [e.action, e.actor?.name])).toEqual([
      ["stage.move", "Ana"],
      ["stage.move", "Bruno"],
      ["order.takeOver", "Bruno"],
      ["order.claim", "Ana"],
    ]);
    expect(entries[0]).toMatchObject({
      category: "status",
      params: { from: "PICKING", to: "ON_HOLD", reason: "Address" },
      station: "Tablet 3",
      count: 1,
      members: [],
    });
    expect(entries[2]).toMatchObject({ params: { name: "Ana" }, station: null });
    expect(entries[3]).toMatchObject({ category: "status", station: "Tablet 3" });
  });

  it("marks store-sync work as the system's", async () => {
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
    await db.auditEvent.create({
      data: {
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        action: "order.externalChange.flagged",
      },
    });

    const { entries } = await getOrderActivity(db, picker, { id: order.id });
    expect(entries.map((e) => [e.action, e.category, e.actor, e.system])).toEqual([
      ["order.externalChange.flagged", "store", null, "store-sync"],
      ["stage.move", "status", null, "store-sync"],
      ["stage.move", "status", { id: picker.userId, name: "Test User" }, null],
    ]);
  });

  it("reads audit rows by orderId only, labels their targets and cleans their details", async () => {
    const { order, items, packages } = await createOrder(db, {
      lines: [{ name: "Lavender soap 8 oz" }],
      packages: [{ items: [{ line: 0, quantity: 1 }] }],
    });
    const { order: other } = await createOrder(db);
    const row = (data: Record<string, unknown>) =>
      db.auditEvent.create({
        data: { actorId: picker.userId, entityId: order.id, action: "x", ...data } as never,
      });
    await row({ entityType: "OrderItem", entityId: items[0]?.id, orderId: order.id, at: t(1).now });
    await row({
      entityType: "Package",
      entityId: packages[0]?.id,
      orderId: order.id,
      action: "package.setWeight",
      before: { weightOz: 36, version: 2, packageId: packages[0]?.id },
      after: { weightOz: 41, customerEmail: "a@b.c" },
      at: t(2).now,
    });
    // A deleted package keeps its number in the row it left behind.
    await row({
      entityType: "Package",
      entityId: "0199e6a0-0000-7000-8000-0000000000ff",
      orderId: order.id,
      action: "package.delete",
      before: { number: 4 },
      at: t(3).now,
    });
    // Rows about the order by entity but without orderId aren't the order's (#197 backfills them).
    await row({ entityType: "Order", at: t(4).now });
    await row({ entityType: "Order", entityId: other.id, orderId: other.id, at: t(5).now });

    const { entries } = await getOrderActivity(db, picker, { id: order.id });
    expect(entries.map((e) => [e.action, e.target])).toEqual([
      ["package.delete", { kind: "box", number: 4 }],
      ["package.setWeight", { kind: "box", number: packages[0]?.number }],
      ["x", { kind: "line", name: "Lavender soap 8 oz" }],
    ]);
    expect(entries[1]?.details).toEqual({ before: { weightOz: 36 }, after: { weightOz: 41 } });
  });

  it("files an unknown action under its entity's category, for the generic line", async () => {
    const { order } = await createOrder(db);
    await db.auditEvent.create({
      data: {
        entityType: "ShippingLabel",
        entityId: "0199e6a0-0000-7000-8000-0000000000ee",
        orderId: order.id,
        action: "label.somethingNew",
      },
    });
    const { entries } = await getOrderActivity(db, picker, { id: order.id });
    expect(entries[0]).toMatchObject({
      action: "label.somethingNew",
      entityType: "ShippingLabel",
      category: "shipping",
      target: null,
    });
  });

  it("groups consecutive repeats into one expandable entry", async () => {
    const { order, packages } = await createOrder(db, {
      packages: [{ items: [{ line: 0, quantity: 1 }] }],
    });
    const times = [1, 2, 3].map((min) => t(min).now);
    for (const at of times) {
      await db.auditEvent.create({
        data: {
          actorId: picker.userId,
          entityType: "Package",
          entityId: packages[0]?.id as string,
          orderId: order.id,
          action: "package.scan",
          at,
        },
      });
    }
    const { entries } = await getOrderActivity(db, picker, { id: order.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: 3, firstAt: times[0], at: times[2] });
    expect(entries[0]?.members).toHaveLength(3);
  });

  it(`reads at most ${TIMELINE_ROW_CAP} rows and says when it was cut`, async () => {
    const { order } = await createOrder(db);
    const start = Date.now() - 1_000_000;
    // Spaced 10 minutes apart and from the system, so none of them group.
    await db.auditEvent.createMany({
      data: Array.from({ length: TIMELINE_ROW_CAP + 1 }, (_, i) => ({
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        action: "order.externalChange.flagged",
        at: new Date(start + i * 600_000),
      })),
    });
    const { entries, truncated } = await getOrderActivity(db, picker, { id: order.id });
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(TIMELINE_ROW_CAP);
    // The newest are kept.
    expect(entries[0]?.at.getTime()).toBe(start + TIMELINE_ROW_CAP * 600_000);
  });
});
