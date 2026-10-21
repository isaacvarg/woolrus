import { describe, expect, it } from "vitest";
import { codesForLine, normalizeCode } from "./codes";

describe("normalizeCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeCode("  lav-8oz \t")).toBe("LAV-8OZ");
  });
});

describe("codesForLine", () => {
  it("collects variation and product barcodes and SKUs and the line SKU, normalized", () => {
    const codes = codesForLine({
      sku: "line-sku",
      product: { barcode: " 0123 ", sku: "prod-sku" },
      variation: { barcode: "4567", sku: "var-sku" },
    });

    expect([...codes].sort()).toEqual(["0123", "4567", "LINE-SKU", "PROD-SKU", "VAR-SKU"]);
  });

  it("skips missing and blank codes", () => {
    const codes = codesForLine({
      sku: "  ",
      product: { barcode: null, sku: "P1" },
      variation: null,
    });

    expect([...codes]).toEqual(["P1"]);
  });

  it("works for a line whose product is gone", () => {
    expect([...codesForLine({ sku: "x1", product: null, variation: null })]).toEqual(["X1"]);
  });
});
