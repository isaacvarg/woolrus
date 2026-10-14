import { describe, expect, it } from "vitest";
import { ouncesToPounds, poundsToOunces, splitPoundsOunces } from "./units";

describe("units", () => {
  it("splits ounces into pounds and ounces", () => {
    expect(splitPoundsOunces(37)).toEqual({ lb: 2, oz: 5 });
    expect(splitPoundsOunces(15.999)).toEqual({ lb: 1, oz: 0 });
    expect(splitPoundsOunces(4.5)).toEqual({ lb: 0, oz: 4.5 });
  });

  it("round-trips pounds and ounces", () => {
    expect(poundsToOunces(2.5)).toBe(40);
    expect(ouncesToPounds(40)).toBe(2.5);
  });
});
