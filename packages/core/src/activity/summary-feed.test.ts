import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { claim } from "../workflow/claims";
import { beginPicking, hold, resume } from "../workflow/service";
import { getOrderActivity } from "./timeline";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let picker: UserActor;
let lead: UserActor;
beforeEach(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
  lead = await createActor(db, ["ADMIN"]);
  await db.user.update({ where: { id: picker.userId }, data: { name: "Ana" } });
});

const MIN = 60_000;

describe("orders.activity summary", () => {
  it("returns time per stage and the people who worked it, from the order's own records", async () => {
    const { order } = await createOrder(db);
    const start = new Date(Date.now() - 2 * 60 * MIN);
    // The import's stage event; the factory writes none.
    await db.orderStageEvent.create({
      data: { orderId: order.id, toStatus: "PENDING", at: start },
    });
    const at = (min: number) => ({ now: new Date(start.getTime() + min * MIN) });

    await claim(db, picker, { orderId: order.id, expectedVersion: 1 }, at(5));
    await beginPicking(db, picker, { orderId: order.id, expectedVersion: 2 }, at(10));
    await hold(db, lead, { orderId: order.id, expectedVersion: 3, reason: "Stock" }, at(20));
    await resume(db, lead, { orderId: order.id, expectedVersion: 4 }, at(50));

    const feed = await getOrderActivity(db, picker, { id: order.id }, at(60));

    expect(feed.summary.stages.map((s) => [s.stage, s.statusMs / MIN])).toEqual([
      ["PENDING", 10],
      ["PICKING", 20],
      ["PACKING", 0],
      ["QA", 0],
      ["READY", 0],
    ]);
    expect(feed.summary.onHoldMs).toBe(30 * MIN);
    const picking = feed.summary.stages[1];
    expect(picking?.intervals.map((i) => [i.running, i.waitingMs, i.workingMs])).toEqual([
      [false, 0, 10 * MIN],
      [true, 10 * MIN, 0],
    ]);
    expect(feed.people.find((p) => p.stage === "PICKING")?.people).toEqual([
      expect.objectContaining({ id: picker.userId, name: "Ana", count: 1, spanMs: 0 }),
      expect.objectContaining({ id: lead.userId, count: 1 }),
    ]);
  });
});
