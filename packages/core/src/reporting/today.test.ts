import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { reportsToday } from "./today";

// SPEC-reporting "Home dashboard": for `report.read` holders, shipped today (viewer's zone) and
// the median import → shipped over the last 7 days, read the way the cycle-time report reads it.

const db: Db = testDb();
afterAll(() => db.$disconnect());

const MIN = 60_000;
const timeZone = "America/Chicago";
// 09:00 on Nov 18 in Chicago.
const now = new Date("2026-11-18T15:00:00Z");

let admin: UserActor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
});

/** An order imported at `importedAt` and shipped `minutes` later. */
async function shipped(importedAt: string, minutes: number) {
  const { order } = await createOrder(db);
  const t0 = Date.parse(importedAt);
  await db.orderStageEvent.createMany({
    data: [
      { orderId: order.id, fromStatus: null, toStatus: "PENDING", at: new Date(t0) },
      {
        orderId: order.id,
        fromStatus: "PENDING",
        toStatus: "COMPLETED",
        actorId: admin.userId,
        at: new Date(t0 + minutes * MIN),
      },
    ],
  });
  return order;
}

describe("reports.today", () => {
  it("needs report.read", async () => {
    for (const roles of [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"], ["RATE_LAB"]] as const) {
      const viewer = await createActor(db, [...roles]);
      await expect(reportsToday(db, viewer, { timeZone }, now)).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    }
    const lead = await createActor(db, ["PACKER", "REPORTS"]);
    await expect(reportsToday(db, lead, { timeZone }, now)).resolves.toBeDefined();
    await expect(reportsToday(db, admin, { timeZone }, now)).resolves.toBeDefined();
  });

  it("counts today's shipments in the viewer's zone and takes the 7-day median", async () => {
    // Today in Chicago: shipped 00:30 and 08:00 local (60 and 30 minutes).
    await shipped("2026-11-18T05:30:00Z", 60);
    await shipped("2026-11-18T13:30:00Z", 30);
    // Six days ago, the first day of the 7: 120 minutes.
    await shipped("2026-11-12T15:00:00Z", 120);
    // 23:30 yesterday in Chicago (05:30 UTC today): in the 7 days, not today. 90 minutes.
    await shipped("2026-11-18T04:00:00Z", 90);
    // Seven days ago: outside both.
    await shipped("2026-11-11T15:00:00Z", 600);

    expect(await reportsToday(db, admin, { timeZone }, now)).toEqual({
      today: "2026-11-18",
      shippedToday: 2,
      // 30, 60, 90, 120 → (60 + 90) / 2.
      medianCycleMs: 75 * MIN,
    });
  });

  it("reads zero and no median when nothing shipped", async () => {
    expect(await reportsToday(db, admin, { timeZone: "UTC" }, now)).toEqual({
      today: "2026-11-18",
      shippedToday: 0,
      medianCycleMs: null,
    });
  });
});
