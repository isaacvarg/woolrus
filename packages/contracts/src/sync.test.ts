import { describe, expect, it } from "vitest";
import { ListSyncRunsInput, RunSyncInput, TestConnectionResult } from "./sync";

describe("sync contract", () => {
  it("defaults and caps the runs page size, coercing query strings", () => {
    expect(ListSyncRunsInput.parse({})).toEqual({ limit: 25 });
    expect(ListSyncRunsInput.parse({ limit: "10", type: "PRODUCTS" })).toEqual({
      limit: 10,
      type: "PRODUCTS",
    });
    expect(ListSyncRunsInput.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("needs a known target and an idempotency key to queue a run", () => {
    expect(RunSyncInput.safeParse({ target: "orders" }).success).toBe(false);
    expect(RunSyncInput.safeParse({ idempotencyKey: "abcdefgh", target: "users" }).success).toBe(
      false,
    );
    expect(RunSyncInput.parse({ idempotencyKey: "abcdefgh", target: "products" })).toEqual({
      idempotencyKey: "abcdefgh",
      target: "products",
    });
  });

  it("reports units on success and only a message key on failure", () => {
    expect(
      TestConnectionResult.parse({ ok: true, units: { weight: "lbs", dimension: "in" } }),
    ).toEqual({ ok: true, units: { weight: "lbs", dimension: "in" } });
    expect(
      TestConnectionResult.parse({ ok: false, messageKey: "errors.sync.unauthorized", extra: 1 }),
    ).toEqual({ ok: false, messageKey: "errors.sync.unauthorized" });
  });
});
