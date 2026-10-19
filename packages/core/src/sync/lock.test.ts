import type { Db } from "@woolrus/db";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "../../test/db";
import { withSyncLock } from "./lock";

const db: Db = testDb();
const other: Db = testDb();
afterAll(() => Promise.all([db.$disconnect(), other.$disconnect()]));

describe("withSyncLock", () => {
  it("runs the function and returns its result", async () => {
    expect(await withSyncLock(db, "orders", async () => 42)).toEqual({
      acquired: true,
      result: 42,
    });
  });

  it("doesn't run while another process holds the same lock", async () => {
    let inner: unknown;
    await withSyncLock(db, "orders", async () => {
      inner = await withSyncLock(other, "orders", async () => "ran");
    });
    expect(inner).toEqual({ acquired: false });
  });

  it("lets a different lock run at the same time", async () => {
    let inner: unknown;
    await withSyncLock(db, "orders", async () => {
      inner = await withSyncLock(other, "products", async () => "ran");
    });
    expect(inner).toEqual({ acquired: true, result: "ran" });
  });

  it("releases the lock when the function throws", async () => {
    await expect(
      withSyncLock(db, "orders", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withSyncLock(other, "orders", async () => "again")).toEqual({
      acquired: true,
      result: "again",
    });
  });
});
