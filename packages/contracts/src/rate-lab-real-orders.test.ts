import { afterEach, describe, expect, it, vi } from "vitest";
import { toFieldErrors } from "./base";
import { REAL_ORDERS_MAX_DAYS, RealOrdersInput } from "./rate-lab-real-orders";

function fieldsOf(input: unknown) {
  const result = RealOrdersInput.safeParse(input);
  return result.success ? {} : toFieldErrors(result.error.issues);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RealOrdersInput", () => {
  it("reads the query string's text the way RPC's values read", () => {
    expect(RealOrdersInput.parse({ includeFake: "true", alternativesLimit: "50" })).toMatchObject({
      includeFake: true,
      alternativesLimit: 50,
    });
    expect(RealOrdersInput.parse({})).toMatchObject({ includeFake: false, alternativesLimit: 100 });
  });

  it("allows no alternatives, and caps them", () => {
    expect(RealOrdersInput.parse({ alternativesLimit: 0 }).alternativesLimit).toBe(0);
    expect(fieldsOf({ alternativesLimit: -1 })).toHaveProperty("alternativesLimit");
    expect(fieldsOf({ alternativesLimit: 501 })).toHaveProperty("alternativesLimit");
  });

  it(`reads at most ${REAL_ORDERS_MAX_DAYS} days, both ends included`, () => {
    expect(RealOrdersInput.safeParse({ from: "2028-01-01", to: "2028-12-31" }).success).toBe(true);
    // The raw issue: toFieldErrors keeps the key once the catalogs carry it.
    const result = RealOrdersInput.safeParse({ from: "2027-01-01", to: "2028-01-02" });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["from"], message: "errors.field.dateRangeTooLong" }),
    ]);
  });

  it("counts a range without an end up to today", () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
    expect(RealOrdersInput.safeParse({ from: "2025-11-05" }).success).toBe(true);
    expect(RealOrdersInput.safeParse({ from: "2025-11-04" }).success).toBe(false);
    expect(RealOrdersInput.safeParse({ to: "2026-01-01" }).success).toBe(true);
  });

  it("still refuses an end before the start", () => {
    expect(fieldsOf({ from: "2026-11-02", to: "2026-11-01" })).toEqual({
      to: "errors.field.dateRange",
    });
  });
});
