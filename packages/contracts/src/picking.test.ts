import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import {
  CompletePickBatchInput,
  CreatePickBatchInput,
  LinkBarcodeInput,
  MarkOutOfStockInput,
  PickLineInput,
  ScanBatchInput,
  ScanInput,
  SubstituteInput,
} from "./picking";
import { PICK_BATCH_MAX_ORDERS_CEILING } from "./settings";

const id = (n: number) => `0199e6a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const itemId = id(1);
const idempotencyKey = "pick-key-1";
const refs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: id(i + 1), expectedVersion: 1 }));

const fieldErrors = (result: { error?: { issues: Parameters<typeof toFieldErrors>[0] } }) =>
  toFieldErrors(result.error?.issues ?? []);

describe("PickLineInput", () => {
  it("takes 1 to 10,000 units, or none for the whole line", () => {
    expect(PickLineInput.safeParse({ itemId }).success).toBe(true);
    expect(PickLineInput.safeParse({ itemId, quantity: 1 }).success).toBe(true);
    expect(PickLineInput.safeParse({ itemId, quantity: 10_000 }).success).toBe(true);
    expect(PickLineInput.safeParse({ itemId, quantity: 0 }).success).toBe(false);
    expect(PickLineInput.safeParse({ itemId, quantity: 10_001 }).success).toBe(false);
    expect(PickLineInput.safeParse({ itemId, quantity: 1.5 }).success).toBe(false);
  });
});

describe("MarkOutOfStockInput", () => {
  const base = { itemId, idempotencyKey, note: "Only one" };

  it("takes a found count from 0 to 10,000", () => {
    expect(MarkOutOfStockInput.safeParse({ ...base, foundQuantity: 0 }).success).toBe(true);
    expect(MarkOutOfStockInput.safeParse({ ...base, foundQuantity: 10_000 }).success).toBe(true);
    expect(MarkOutOfStockInput.safeParse({ ...base, foundQuantity: -1 }).success).toBe(false);
    expect(MarkOutOfStockInput.safeParse({ ...base, foundQuantity: 10_001 }).success).toBe(false);
  });

  it("trims the note and requires one", () => {
    expect(MarkOutOfStockInput.parse({ ...base, foundQuantity: 0, note: " Gone \n" }).note).toBe(
      "Gone",
    );
    const blank = MarkOutOfStockInput.safeParse({ ...base, foundQuantity: 0, note: "   " });
    expect(fieldErrors(blank)).toEqual({ note: "errors.field.required" });
    const long = MarkOutOfStockInput.safeParse({
      ...base,
      foundQuantity: 0,
      note: "x".repeat(501),
    });
    expect(fieldErrors(long)).toEqual({ note: "errors.field.tooBig" });
  });
});

describe("SubstituteInput", () => {
  const base = { itemId, idempotencyKey };

  it("trims what went in and requires it", () => {
    expect(SubstituteInput.parse({ ...base, substitute: " Rose soap " }).substitute).toBe(
      "Rose soap",
    );
    expect(fieldErrors(SubstituteInput.safeParse({ ...base, substitute: " " }))).toEqual({
      substitute: "errors.field.required",
    });
    expect(
      fieldErrors(SubstituteInput.safeParse({ ...base, substitute: "x".repeat(201) })),
    ).toEqual({ substitute: "errors.field.tooBig" });
  });

  it("takes an optional note up to 500 characters", () => {
    expect(SubstituteInput.safeParse({ ...base, substitute: "x", note: "" }).success).toBe(true);
    expect(
      SubstituteInput.safeParse({ ...base, substitute: "x", note: "x".repeat(501) }).success,
    ).toBe(false);
  });
});

describe("scanned codes", () => {
  it.each([
    ["ScanInput", ScanInput, { orderId: id(1), scanId: "scan-id-1" }],
    ["ScanBatchInput", ScanBatchInput, { batchId: id(1), scanId: "scan-id-1" }],
    ["LinkBarcodeInput", LinkBarcodeInput, { orderItemId: id(1) }],
  ] as const)("%s trims the code and takes 1 to 200 characters", (_, schema, base) => {
    expect(schema.parse({ ...base, code: " lav-8\t" }).code).toBe("lav-8");
    expect(schema.safeParse({ ...base, code: "x".repeat(200) }).success).toBe(true);
    expect(fieldErrors(schema.safeParse({ ...base, code: "  " }))).toEqual({
      code: "errors.field.required",
    });
    expect(fieldErrors(schema.safeParse({ ...base, code: "x".repeat(201) }))).toEqual({
      code: "errors.field.tooBig",
    });
  });
});

describe("CreatePickBatchInput", () => {
  it("takes 2 up to the settings ceiling of distinct orders", () => {
    expect(CreatePickBatchInput.safeParse({ idempotencyKey, orders: refs(2) }).success).toBe(true);
    expect(
      CreatePickBatchInput.safeParse({
        idempotencyKey,
        orders: refs(PICK_BATCH_MAX_ORDERS_CEILING),
      }).success,
    ).toBe(true);
    expect(CreatePickBatchInput.safeParse({ idempotencyKey, orders: refs(1) }).success).toBe(false);
    expect(
      CreatePickBatchInput.safeParse({
        idempotencyKey,
        orders: refs(PICK_BATCH_MAX_ORDERS_CEILING + 1),
      }).success,
    ).toBe(false);
  });

  it("refuses the same order twice", () => {
    const [one] = refs(1) as [{ id: string; expectedVersion: number }];
    const result = CreatePickBatchInput.safeParse({ idempotencyKey, orders: [one, one] });
    expect(fieldErrors(result)).toEqual({ orders: "errors.field.invalid" });
  });
});

describe("CompletePickBatchInput", () => {
  it("takes at least one distinct order", () => {
    expect(CompletePickBatchInput.safeParse({ id: id(9), orders: refs(1) }).success).toBe(true);
    expect(CompletePickBatchInput.safeParse({ id: id(9), orders: [] }).success).toBe(false);
    const [one] = refs(1) as [{ id: string; expectedVersion: number }];
    expect(
      fieldErrors(CompletePickBatchInput.safeParse({ id: id(9), orders: [one, one] })),
    ).toEqual({ orders: "errors.field.invalid" });
  });
});
