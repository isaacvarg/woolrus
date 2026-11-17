import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { dailyOrderActivity } from "./activity";

const db: Db = testDb();
afterAll(() => db.$disconnect());

let picker: UserActor;
beforeEach(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);
});

const now = new Date("2026-03-10T15:00:00Z");

describe("dailyOrderActivity", () => {
  it("needs order.read", async () => {
    const nobody = await createActor(db, []);
    await expect(dailyOrderActivity(db, nobody, {}, { now })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("counts received and completed orders per day, every day present, oldest first", async () => {
    await createOrder(db, { orderedAt: new Date("2026-03-10T09:00:00Z") });
    await createOrder(db, { orderedAt: new Date("2026-03-10T01:00:00Z") });
    await createOrder(db, { orderedAt: new Date("2026-03-04T12:00:00Z") });
    // Outside the 7 days.
    await createOrder(db, { orderedAt: new Date("2026-03-03T12:00:00Z") });
    const { order } = await createOrder(db, {
      status: "COMPLETED",
      orderedAt: new Date("2026-03-01T12:00:00Z"),
    });
    await db.order.update({
      where: { id: order.id },
      data: { completedAt: new Date("2026-03-09T12:00:00Z") },
    });

    const days = await dailyOrderActivity(db, picker, { days: 7 }, { now });
    expect(days.map((d) => d.day)).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(days[0]).toEqual({ day: "2026-03-04", received: 1, completed: 0 });
    expect(days[5]).toEqual({ day: "2026-03-09", received: 0, completed: 1 });
    expect(days[6]).toEqual({ day: "2026-03-10", received: 2, completed: 0 });
  });

  it("buckets by the viewer's calendar day", async () => {
    // 01:00 UTC on the 10th is 20:00 on the 9th in Chicago (UTC−5 after the March 8 DST change).
    await createOrder(db, { orderedAt: new Date("2026-03-10T01:00:00Z") });

    const days = await dailyOrderActivity(
      db,
      picker,
      { days: 7, timeZone: "America/Chicago" },
      { now },
    );
    expect(days.at(-1)).toEqual({ day: "2026-03-10", received: 0, completed: 0 });
    expect(days.at(-2)).toEqual({ day: "2026-03-09", received: 1, completed: 0 });
  });
});
