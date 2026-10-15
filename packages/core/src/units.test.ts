import { describe, expect, it } from "vitest";
import {
  ouncesToPounds,
  poundsToOunces,
  splitPoundsOunces,
  toCents,
  toInches,
  toOunces,
} from "./units";

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

  it("converts store weights to ounces, rounded to hundredths", () => {
    expect(toOunces("0.3", "lbs")).toBe(4.8);
    expect(toOunces("1.1", "lbs")).toBe(17.6);
    expect(toOunces("4.5", "oz")).toBe(4.5);
    expect(toOunces("1", "kg")).toBe(35.27);
    expect(toOunces("500", "g")).toBe(17.64);
    expect(toOunces(null, "lbs")).toBeNull();
  });

  it("converts store dimensions to inches, rounded to hundredths", () => {
    expect(toInches("2", "in")).toBe(2);
    expect(toInches("10", "cm")).toBe(3.94);
    expect(toInches("100", "mm")).toBe(3.94);
    expect(toInches("1", "m")).toBe(39.37);
    expect(toInches("0.5", "yd")).toBe(18);
    expect(toInches(null, "cm")).toBeNull();
  });

  it("rejects text that isn't a decimal number", () => {
    expect(() => toOunces("heavy", "lbs")).toThrow(/not a decimal/);
    expect(() => toInches("1e3", "in")).toThrow(/not a decimal/);
  });
});

describe("toCents", () => {
  it("parses decimal strings to integer cents without floats", () => {
    expect(toCents("24.00")).toBe(2400);
    expect(toCents("8")).toBe(800);
    expect(toCents("0.5")).toBe(50);
    expect(toCents(".5")).toBe(50);
    expect(toCents("-5.25")).toBe(-525);
    expect(toCents("19.99")).toBe(1999);
    expect(toCents("1234567.89")).toBe(123456789);
  });

  it("sums exactly where floats wouldn't", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toCents("0.1") + toCents("0.2")).toBe(toCents("0.3"));
  });

  it("rounds sub-cent amounts half away from zero", () => {
    // Woo computes line prices as subtotal / quantity, e.g. 25.00 / 3.
    expect(toCents("8.333333")).toBe(833);
    expect(toCents("8.335")).toBe(834);
    expect(toCents("8.3349999")).toBe(833);
    expect(toCents("0.995")).toBe(100);
    expect(toCents("-0.005")).toBe(-1);
  });

  it("rejects text that isn't a decimal number", () => {
    for (const bad of ["", "abc", "1,000.00", "1e3", "1.2.3", "-"]) {
      expect(() => toCents(bad)).toThrow(/not a decimal/);
    }
  });
});
