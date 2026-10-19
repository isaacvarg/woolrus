import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { isPollDue, pollIfDue } from "./schedule";

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 19, 12, minute, second));

describe("isPollDue (FR-SYNC-09)", () => {
  it.each([
    { last: null, now: at(0), interval: 5, due: true },
    { last: at(0), now: at(1), interval: 5, due: false },
    { last: at(0), now: at(4, 59), interval: 5, due: false },
    { last: at(0), now: at(5), interval: 5, due: true },
    { last: at(0), now: at(17), interval: 5, due: true },
    { last: at(0), now: at(1), interval: 1, due: true },
    { last: at(0), now: at(14), interval: 15, due: false },
    // A clock that moved back (last start in the future) doesn't stall polling for good.
    { last: at(30), now: at(10), interval: 5, due: true },
  ])("last $last, now $now, every $interval min → $due", ({ last, now, interval, due }) => {
    expect(isPollDue(last, interval, now)).toBe(due);
  });
});

describe("pollIfDue", () => {
  const db: Db = testDb();
  afterAll(() => db.$disconnect());

  let store: FakeStoreAdapter;
  beforeEach(async () => {
    await resetDb(db);
    store = new FakeStoreAdapter();
    store.addOrder();
  });

  it("with a 5-minute interval, minute ticks poll only once 5 minutes have passed", async () => {
    await db.settings.create({ data: { syncIntervalMinutes: 5 } });

    const ticks = [];
    for (let minute = 0; minute <= 10; minute++) {
      ticks.push((await pollIfDue(db, store, { reason: "schedule", now: at(minute) })).status);
    }

    expect(ticks.map((s) => s !== "notDue")).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(await db.syncRun.count({ where: { type: "ORDERS_POLL" } })).toBe(3);
  });

  it("uses the default interval when settings were never saved", async () => {
    await pollIfDue(db, store, { reason: "schedule", now: at(0) });

    expect((await pollIfDue(db, store, { reason: "schedule", now: at(4) })).status).toBe("notDue");
    expect((await pollIfDue(db, store, { reason: "schedule", now: at(5) })).status).not.toBe(
      "notDue",
    );
  });

  it("counts a failed poll as the last start, so a broken store isn't hammered every minute", async () => {
    await pollIfDue(db, null, { reason: "schedule", now: at(0) });

    expect((await pollIfDue(db, store, { reason: "schedule", now: at(1) })).status).toBe("notDue");
  });

  it("runs a manual poll at once", async () => {
    await pollIfDue(db, store, { reason: "schedule", now: at(0) });

    const manual = await pollIfDue(db, store, { reason: "manual", now: at(1) });

    expect(manual.status).toBe("SUCCEEDED");
    expect(await db.syncRun.count()).toBe(2);
  });
});
