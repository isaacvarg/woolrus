import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type PackageSpec } from "../../test/factories";
import type { UserActor } from "../permissions";
import { completePack } from "./complete";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

/** A Packing order claimed by `packer` (a fresh Packer by default), fully packed and weighed. */
async function packed(packer?: UserActor, packages?: PackageSpec[]) {
  const actor = packer ?? (await createActor(db, ["PACKER"]));
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: actor.userId,
    lines: [{ quantity: 2, pickStatus: "PICKED" }],
    packages: packages ?? [{ items: [{ line: 0, quantity: 2 }], weightOz: 36 }],
  });
  return { packer: actor, ...built };
}

const waiting = (orderedAt: Date, extra: { claimedById?: string; claimedAt?: Date } = {}) =>
  createOrder(db, { status: "PACKING", orderedAt, ...extra }).then((b) => b.order);

const finish = (
  actor: UserActor,
  order: { id: string },
  after: "queue" | "next",
  expectedVersion = 3,
) => completePack(db, actor, { orderId: order.id, expectedVersion, after });

describe("completePack", () => {
  it("queue: moves the order to QA with no claim and nothing else", async () => {
    const { packer, order } = await packed();
    const other = await waiting(minutesAgo(5));

    expect(await finish(packer, order, "queue")).toEqual({ nextOrderId: null });
    expect(await orderRow(order.id)).toMatchObject({ status: "QA", claimedById: null });
    expect(await orderRow(other.id)).toMatchObject({ status: "PACKING", claimedById: null });
  });

  it("next: claims the first unclaimed Packing order in queue order", async () => {
    const { packer, order } = await packed();
    const someone = await createActor(db, ["PACKER"]);
    await waiting(minutesAgo(10));
    await waiting(minutesAgo(60), { claimedById: someone.userId, claimedAt: new Date() });
    const oldest = await waiting(minutesAgo(40));

    const result = await finish(packer, order, "next");

    expect(result).toEqual({ nextOrderId: oldest.id });
    expect(await orderRow(order.id)).toMatchObject({ status: "QA" });
    expect(await orderRow(oldest.id)).toMatchObject({
      status: "PACKING",
      claimedById: packer.userId,
    });
  });

  it("next: returns null when no unclaimed Packing order is left", async () => {
    const { packer, order } = await packed();
    const someone = await createActor(db, ["PACKER"]);
    await waiting(minutesAgo(10), { claimedById: someone.userId, claimedAt: new Date() });

    expect(await finish(packer, order, "next")).toEqual({ nextOrderId: null });
  });

  it("next: two packers finishing at once get different orders", async () => {
    const a = await packed();
    const b = await packed();
    const first = await waiting(minutesAgo(20));
    const second = await waiting(minutesAgo(10));

    const results = await Promise.all([
      finish(a.packer, a.order, "next"),
      finish(b.packer, b.order, "next"),
    ]);

    expect(new Set(results.map((r) => r.nextOrderId))).toEqual(new Set([first.id, second.id]));
  });

  it("next: with one order left, two packers at once give it to exactly one", async () => {
    const a = await packed();
    const b = await packed();
    const only = await waiting(minutesAgo(10));

    const results = await Promise.all([
      finish(a.packer, a.order, "next"),
      finish(b.packer, b.order, "next"),
    ]);

    expect(results.map((r) => r.nextOrderId).sort()).toEqual([null, only.id].sort());
  });

  it.each(["queue", "next"] as const)("%s: a gate failure moves nothing", async (after) => {
    const { packer, order } = await packed(undefined, [
      { items: [{ line: 0, quantity: 2 }], weightOz: null },
    ]);
    const next = await waiting(minutesAgo(10));

    await expect(finish(packer, order, after)).rejects.toMatchObject({
      kind: "CONFLICT",
      unmet: [{ messageKey: "errors.workflow.gate.packageNoWeight" }],
    });
    expect(await orderRow(order.id)).toMatchObject({
      status: "PACKING",
      version: 3,
      claimedById: packer.userId,
    });
    expect(await orderRow(next.id)).toMatchObject({ claimedById: null });
  });

  it("is refused for a stale version, without the claim, and for a Picker", async () => {
    const { packer, order } = await packed();
    const other = await createActor(db, ["PACKER"]);
    const picker = await createActor(db, ["PICKER"]);

    await expect(finish(packer, order, "queue", 2)).rejects.toMatchObject({
      messageKey: "errors.workflow.stale",
    });
    await expect(finish(other, order, "queue")).rejects.toMatchObject({ kind: "CONFLICT" });
    await expect(finish(picker, order, "queue")).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await orderRow(order.id)).toMatchObject({ status: "PACKING", version: 3 });
  });
});

describe("the re-weigh note", () => {
  const notesOn = (packageId: string) => db.note.findMany({ where: { packageId } });

  it("writes one internal note on each still-flagged package and none on the others", async () => {
    const { packer, order, packages } = await packed(undefined, [
      { items: [{ line: 0, quantity: 1 }], weightOz: 36 },
      { items: [{ line: 0, quantity: 1 }], weightOz: 8 },
    ]);
    await db.package.update({ where: { id: packages[0]?.id }, data: { weightStale: true } });

    await finish(packer, order, "queue");

    const flagged = await notesOn(packages[0]?.id as string);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      orderId: order.id,
      visibility: "INTERNAL",
      authorId: packer.userId,
      content: "Contents changed after weighing; weight 2 lb 4 oz not re-checked",
    });
    expect(await notesOn(packages[1]?.id as string)).toHaveLength(0);
  });

  it("writes none when the gate fails", async () => {
    const { packer, order, packages } = await packed(undefined, [
      { items: [{ line: 0, quantity: 1 }], weightOz: 36 },
    ]);
    await db.package.update({ where: { id: packages[0]?.id }, data: { weightStale: true } });

    await expect(finish(packer, order, "queue")).rejects.toMatchObject({ kind: "CONFLICT" });

    expect(await db.note.count()).toBe(0);
  });
});
