import { describe, expect, it } from "vitest";
import { isLotCode, lotLabel, parseLotCode } from "./codes";

// SPEC-lumexia success criterion 5: what the pack screen's scan field treats as a lot.

describe("parseLotCode", () => {
  it("reads a printed lot number and splits out the item's reference code", () => {
    expect(parseLotCode("BASE1234.A12A0124")).toEqual({
      kind: "number",
      lotNumber: "BASE1234.A12A0124",
      referenceCode: "BASE1234",
    });
  });

  it("trims and upper-cases what the scanner typed", () => {
    expect(parseLotCode("  lav-base-1g.b07c1124\n")).toEqual({
      kind: "number",
      lotNumber: "LAV-BASE-1G.B07C1124",
      referenceCode: "LAV-BASE-1G",
    });
  });

  it("reads a QR code's UUID, lower-cased", () => {
    expect(parseLotCode(" 0190A000-0000-7000-8000-00000000ABCD ")).toEqual({
      kind: "uuid",
      id: "0190a000-0000-7000-8000-00000000abcd",
    });
  });

  it.each([
    ["an EAN barcode", "0123456789012"],
    ["a SKU", "LAV-8OZ"],
    ["a SKU with a dot", "LAV.8OZ"],
    ["a month past L", "BASE1234.A12M0124"],
    ["a short date", "BASE1234.A12A012"],
    ["no reference code", ".A12A0124"],
    ["two dots", "BASE.1234.A12A0124"],
    ["a UUID missing a group", "0190a000-0000-7000-8000"],
    ["nothing", "   "],
  ])("rejects %s", (_name, raw) => {
    expect(parseLotCode(raw)).toBeNull();
    expect(isLotCode(raw)).toBe(false);
  });

  it("says which scans are lots", () => {
    expect(isLotCode("BASE1234.A12A0124")).toBe(true);
    expect(isLotCode("0190a000-0000-7000-8000-00000000abcd")).toBe(true);
  });
});

describe("lotLabel", () => {
  it("shows a lot number without its item's reference code", () => {
    expect(lotLabel("BASE1234.A12A0124")).toBe("A12A0124");
    expect(lotLabel("ODD")).toBe("ODD");
  });
});
