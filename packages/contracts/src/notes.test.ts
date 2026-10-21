import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import { CreateNoteInput, UpdateNoteInput } from "./notes";

const orderId = "0199e6a0-0000-7000-8000-000000000001";

describe("CreateNoteInput", () => {
  it("trims the content and defaults to an internal note", () => {
    expect(
      CreateNoteInput.parse({ idempotencyKey: "note-key-1", orderId, content: "  hello \n" }),
    ).toEqual({ idempotencyKey: "note-key-1", orderId, content: "hello", visibility: "INTERNAL" });
  });

  it("caps the content at 4000 characters", () => {
    const base = { idempotencyKey: "note-key-1", orderId };
    expect(CreateNoteInput.safeParse({ ...base, content: "x".repeat(4000) }).success).toBe(true);
    const result = CreateNoteInput.safeParse({ ...base, content: "x".repeat(4001) });
    expect(result.success).toBe(false);
    expect(toFieldErrors(result.error?.issues ?? [])).toEqual({ content: "errors.field.tooBig" });
  });

  it("accepts only the two visibilities", () => {
    const base = { idempotencyKey: "note-key-1", orderId, content: "hi" };
    expect(CreateNoteInput.safeParse({ ...base, visibility: "CUSTOMER" }).success).toBe(true);
    expect(CreateNoteInput.safeParse({ ...base, visibility: "PUBLIC" }).success).toBe(false);
  });
});

describe("UpdateNoteInput", () => {
  it("changes only what it's given", () => {
    expect(UpdateNoteInput.parse({ id: orderId, visibility: "CUSTOMER" })).toEqual({
      id: orderId,
      visibility: "CUSTOMER",
    });
  });
});
