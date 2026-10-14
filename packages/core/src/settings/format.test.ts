import { describe, expect, it } from "vitest";
import { formatWeight } from "./format";

describe("formatWeight", () => {
  it("shows pounds and ounces for LB_OZ", () => {
    expect(formatWeight(37, "LB_OZ", "en")).toBe("2 lb 5 oz");
  });

  it("shows decimal pounds for LB_DECIMAL, to two places", () => {
    expect(formatWeight(37, "LB_DECIMAL", "en")).toBe("2.31 lb");
  });

  it("shows zero as ounces or pounds", () => {
    expect(formatWeight(0, "LB_OZ", "en")).toBe("0 oz");
    expect(formatWeight(0, "LB_DECIMAL", "en")).toBe("0 lb");
  });

  it("drops the ounces for a whole number of pounds", () => {
    expect(formatWeight(32, "LB_OZ", "en")).toBe("2 lb");
    expect(formatWeight(32, "LB_DECIMAL", "en")).toBe("2 lb");
  });

  it("drops the pounds under one pound", () => {
    expect(formatWeight(4.5, "LB_OZ", "en")).toBe("4.5 oz");
  });

  it("carries ounces that round to 16 into the next pound", () => {
    expect(formatWeight(15.999, "LB_OZ", "en")).toBe("1 lb");
    expect(formatWeight(47.999, "LB_OZ", "en")).toBe("3 lb");
  });

  it("uses the locale's decimal separator", () => {
    expect(formatWeight(37, "LB_DECIMAL", "es")).toBe("2,31 lb");
    expect(formatWeight(36.5, "LB_OZ", "es")).toBe("2 lb 4,5 oz");
  });
});
