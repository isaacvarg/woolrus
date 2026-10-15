import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toFieldErrors } from "./base";
import {
  ClaimManyInput,
  ForceStatusInput,
  OrderReasonInput,
  OrderVersionInput,
  TakeOverInput,
} from "./orders";

const id = "0199e6a0-0000-7000-8000-000000000001";
const id2 = "0199e6a0-0000-7000-8000-000000000002";

function fieldsOf(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a validation failure");
  return toFieldErrors(result.error.issues);
}

describe("OrderVersionInput", () => {
  it("needs a uuid and a positive integer version", () => {
    expect(OrderVersionInput.parse({ id, expectedVersion: 3 })).toEqual({ id, expectedVersion: 3 });
    expect(fieldsOf(OrderVersionInput, { id: "x", expectedVersion: 0 })).toEqual({
      id: "errors.field.invalid",
      expectedVersion: "errors.field.tooSmall",
    });
    expect(fieldsOf(OrderVersionInput, { id, expectedVersion: 1.5 })).toEqual({
      expectedVersion: "errors.field.invalid",
    });
  });
});

describe("OrderReasonInput", () => {
  it("trims the reason and requires it", () => {
    expect(
      OrderReasonInput.parse({ id, expectedVersion: 1, reason: "  address change " }),
    ).toMatchObject({
      reason: "address change",
    });
    expect(fieldsOf(OrderReasonInput, { id, expectedVersion: 1, reason: "   " })).toEqual({
      reason: "errors.field.required",
    });
    expect(fieldsOf(OrderReasonInput, { id, expectedVersion: 1 })).toEqual({
      reason: "errors.field.invalid",
    });
  });

  it("caps the reason at 500 characters", () => {
    expect(fieldsOf(OrderReasonInput, { id, expectedVersion: 1, reason: "a".repeat(501) })).toEqual(
      {
        reason: "errors.field.tooBig",
      },
    );
  });
});

describe("ForceStatusInput", () => {
  it("takes a workflow status and a reason", () => {
    expect(
      ForceStatusInput.parse({ id, expectedVersion: 1, to: "READY", reason: "fix" }),
    ).toMatchObject({ to: "READY" });
    expect(
      fieldsOf(ForceStatusInput, { id, expectedVersion: 1, to: "SHIPPED", reason: "fix" }),
    ).toEqual({
      to: "errors.field.invalid",
    });
  });
});

describe("TakeOverInput", () => {
  it("refuses anything but confirm: true", () => {
    expect(TakeOverInput.parse({ id, expectedVersion: 1, confirm: true })).toMatchObject({
      confirm: true,
    });
    expect(fieldsOf(TakeOverInput, { id, expectedVersion: 1, confirm: false })).toEqual({
      confirm: "errors.workflow.takeOverConfirm",
    });
  });
});

describe("ClaimManyInput", () => {
  const order = (orderId: string) => ({ id: orderId, expectedVersion: 1 });

  it("takes 1 to 50 distinct orders", () => {
    expect(ClaimManyInput.parse({ orders: [order(id), order(id2)] }).orders).toHaveLength(2);
    expect(fieldsOf(ClaimManyInput, { orders: [] })).toEqual({ orders: "errors.field.tooSmall" });
    const many = Array.from({ length: 51 }, (_, i) =>
      order(`0199e6a0-0000-7000-8000-${String(i).padStart(12, "0")}`),
    );
    expect(fieldsOf(ClaimManyInput, { orders: many })).toEqual({ orders: "errors.field.tooBig" });
  });

  it("refuses the same order twice", () => {
    expect(fieldsOf(ClaimManyInput, { orders: [order(id), order(id)] })).toEqual({
      orders: "errors.field.invalid",
    });
  });
});
