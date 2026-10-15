import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import {
  CreatePriorityRuleInput,
  PriorityLevel,
  PriorityRuleCondition,
  ReorderPriorityRulesInput,
  UpdatePriorityRuleInput,
} from "./priority-rules";

function fieldErrors(input: unknown) {
  const result = PriorityRuleCondition.safeParse(input);
  return result.success ? {} : toFieldErrors(result.error.issues);
}

describe("PriorityRuleCondition", () => {
  it("accepts each condition type", () => {
    for (const condition of [
      { type: "lineItem", match: "sku", value: "RUSH-ORDER" },
      { type: "lineItem", match: "name", value: "Rush Order" },
      { type: "shippingMethod", contains: "Express" },
      { type: "orderAge", minHours: 48 },
    ]) {
      expect(PriorityRuleCondition.parse(condition)).toEqual(condition);
    }
  });

  it("trims text and requires it", () => {
    expect(PriorityRuleCondition.parse({ type: "shippingMethod", contains: " Express " })).toEqual({
      type: "shippingMethod",
      contains: "Express",
    });
    expect(fieldErrors({ type: "lineItem", match: "sku", value: "  " })).toEqual({
      value: "errors.field.required",
    });
    expect(fieldErrors({ type: "shippingMethod", contains: "" })).toEqual({
      contains: "errors.field.required",
    });
    expect(fieldErrors({ type: "lineItem", match: "sku", value: "x".repeat(201) })).toEqual({
      value: "errors.field.tooBig",
    });
  });

  it("keeps minHours a whole number from 1 to 720", () => {
    expect(fieldErrors({ type: "orderAge", minHours: 1 })).toEqual({});
    expect(fieldErrors({ type: "orderAge", minHours: 720 })).toEqual({});
    expect(fieldErrors({ type: "orderAge", minHours: 0 })).toEqual({
      minHours: "errors.field.tooSmall",
    });
    expect(fieldErrors({ type: "orderAge", minHours: 721 })).toEqual({
      minHours: "errors.field.tooBig",
    });
    expect(fieldErrors({ type: "orderAge", minHours: 1.5 })).toEqual({
      minHours: "errors.field.invalid",
    });
  });

  it("refuses an unknown type or match", () => {
    expect(PriorityRuleCondition.safeParse({ type: "customer", value: "x" }).success).toBe(false);
    expect(fieldErrors({ type: "lineItem", match: "category", value: "x" })).toEqual({
      match: "errors.field.invalid",
    });
  });
});

describe("PriorityLevel", () => {
  it("is 0 Normal, 1 High or 2 Urgent", () => {
    expect([0, 1, 2].map((level) => PriorityLevel.safeParse(level).success)).toEqual([
      true,
      true,
      true,
    ]);
    expect([-1, 3, 1.5].map((level) => PriorityLevel.safeParse(level).success)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("rule inputs", () => {
  const condition = { type: "orderAge", minHours: 48 };
  const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

  it("creates an enabled rule by default and requires a name and level", () => {
    expect(
      CreatePriorityRuleInput.parse({
        idempotencyKey: "key-00000001",
        name: " Old orders ",
        condition,
        priority: 1,
      }),
    ).toEqual({
      idempotencyKey: "key-00000001",
      name: "Old orders",
      condition,
      priority: 1,
      enabled: true,
    });
    const missing = CreatePriorityRuleInput.safeParse({
      idempotencyKey: "key-00000001",
      condition,
    });
    expect(missing.success ? {} : toFieldErrors(missing.error.issues)).toEqual({
      name: "errors.field.invalid",
      priority: "errors.field.invalid",
    });
  });

  it("updates any subset of fields, with nested condition errors", () => {
    expect(UpdatePriorityRuleInput.parse({ id, enabled: false })).toEqual({ id, enabled: false });
    const bad = UpdatePriorityRuleInput.safeParse({
      id,
      condition: { type: "orderAge", minHours: 0 },
    });
    expect(bad.success ? {} : toFieldErrors(bad.error.issues)).toEqual({
      "condition.minHours": "errors.field.tooSmall",
    });
  });

  it("reorders by a list of distinct ids", () => {
    expect(ReorderPriorityRulesInput.safeParse({ ids: [id] }).success).toBe(true);
    expect(ReorderPriorityRulesInput.safeParse({ ids: [id, id] }).success).toBe(false);
  });
});
