import type { PriorityRuleCondition } from "@woolrus/contracts";
import { describe, expect, it } from "vitest";
import { computePriority, type PriorityOrder, type PriorityRuleInput } from "./priority";

const now = new Date("2026-10-15T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

const plain: PriorityOrder = { shippingMethod: "Flat rate", orderedAt: now };
const yarn = { sku: "WOOL-MER-RED", name: "Merino yarn, Red" };
const rush = { sku: "RUSH-ORDER", name: "Rush Order" };

function rule(condition: PriorityRuleCondition, priority = 1, enabled = true): PriorityRuleInput {
  return { condition, priority, enabled };
}

/** The rules the demo seed gets in T18: Rush Order → Urgent, Express or 2+ days old → High. */
const storeRules = [
  rule({ type: "lineItem", match: "sku", value: "RUSH-ORDER" }, 2),
  rule({ type: "shippingMethod", contains: "express" }, 1),
  rule({ type: "orderAge", minHours: 48 }, 1),
];

describe("computePriority", () => {
  it("is 0 with no rules or no match", () => {
    expect(computePriority(plain, [yarn], [], now)).toBe(0);
    expect(computePriority(plain, [yarn], storeRules, now)).toBe(0);
  });

  it("makes an order with the Rush Order SKU Urgent (SC 10)", () => {
    expect(computePriority(plain, [yarn, rush], storeRules, now)).toBe(2);
  });

  it("takes the highest matching rule, whatever its position", () => {
    const express = { ...plain, shippingMethod: "Express", orderedAt: hoursAgo(72) };
    expect(computePriority(express, [rush], storeRules, now)).toBe(2);
    expect(computePriority(express, [rush], [...storeRules].reverse(), now)).toBe(2);
    expect(computePriority(express, [yarn], storeRules, now)).toBe(1);
  });

  it("ignores disabled rules", () => {
    const rules = [rule({ type: "lineItem", match: "sku", value: "RUSH-ORDER" }, 2, false)];
    expect(computePriority(plain, [rush], rules, now)).toBe(0);
  });

  describe("lineItem", () => {
    it("matches a SKU exactly, case included", () => {
      const bySku = [rule({ type: "lineItem", match: "sku", value: "RUSH-ORDER" }, 2)];
      expect(computePriority(plain, [rush], bySku, now)).toBe(2);
      expect(computePriority(plain, [{ ...rush, sku: "rush-order" }], bySku, now)).toBe(0);
      expect(computePriority(plain, [{ ...rush, sku: "RUSH-ORDER-2" }], bySku, now)).toBe(0);
      expect(computePriority(plain, [{ ...rush, sku: null }], bySku, now)).toBe(0);
    });

    it("matches a whole name, ignoring case", () => {
      const byName = [rule({ type: "lineItem", match: "name", value: "Rush Order" }, 2)];
      expect(computePriority(plain, [{ sku: null, name: "RUSH ORDER" }], byName, now)).toBe(2);
      expect(computePriority(plain, [{ sku: null, name: "Rush Order fee" }], byName, now)).toBe(0);
    });
  });

  describe("shippingMethod", () => {
    const express = [rule({ type: "shippingMethod", contains: "Express" })];

    it("matches text anywhere in the method, ignoring case", () => {
      const order = { ...plain, shippingMethod: "USPS Priority EXPRESS" };
      expect(computePriority(order, [yarn], express, now)).toBe(1);
    });

    it("doesn't match another or a missing method", () => {
      expect(computePriority(plain, [yarn], express, now)).toBe(0);
      expect(computePriority({ ...plain, shippingMethod: null }, [yarn], express, now)).toBe(0);
    });
  });

  describe("orderAge", () => {
    const old = [rule({ type: "orderAge", minHours: 48 })];

    it("matches from exactly minHours old", () => {
      const at = (orderedAt: Date) => computePriority({ ...plain, orderedAt }, [yarn], old, now);
      expect(at(new Date(hoursAgo(48).getTime() + 1))).toBe(0);
      expect(at(hoursAgo(48))).toBe(1);
      expect(at(hoursAgo(500))).toBe(1);
    });
  });
});
