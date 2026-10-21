import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import { CreateNoteInput, UpdateNoteInput } from "./notes";

const orderId = "0199e6a0-0000-7000-8000-000000000001";

describe("CreateNoteInput", () => {
  it("trims the content and defaults to an internal note on the order", () => {
    expect(
      CreateNoteInput.parse({ idempotencyKey: "note-key-1", orderId, content: "  hello \n" }),
    ).toEqual({
      idempotencyKey: "note-key-1",
      orderId,
      content: "hello",
      visibility: "INTERNAL",
      target: { kind: "order" },
    });
  });

  it("takes a line, package or issue target by id", () => {
    const base = { idempotencyKey: "note-key-1", orderId, content: "hi" };
    for (const kind of ["item", "package", "issue"]) {
      expect(CreateNoteInput.safeParse({ ...base, target: { kind, id: orderId } }).success).toBe(
        true,
      );
      expect(CreateNoteInput.safeParse({ ...base, target: { kind } }).success).toBe(false);
    }
    expect(CreateNoteInput.safeParse({ ...base, target: { kind: "return" } }).success).toBe(false);
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

  it("range-checks a voice memo's duration, 1 ms to 5 minutes, from a form field too", () => {
    const voice = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], "voice.webm");
    const base = { idempotencyKey: "note-key-1", orderId, content: "", voice };
    const parse = (voiceDurationMs: unknown) =>
      CreateNoteInput.safeParse({ ...base, voiceDurationMs });
    expect(parse(1).success).toBe(true);
    expect(parse(300_000).success).toBe(true);
    // Multipart over /api/v1 sends every field as text.
    expect(parse("20500").data?.voiceDurationMs).toBe(20_500);
    expect(toFieldErrors(parse(0).error?.issues ?? [])).toEqual({
      voiceDurationMs: "errors.field.tooSmall",
    });
    expect(toFieldErrors(parse(300_001).error?.issues ?? [])).toEqual({
      voiceDurationMs: "errors.field.tooBig",
    });
    expect(parse(1.5).success).toBe(false);
  });
});

describe("UpdateNoteInput", () => {
  it("changes only what it's given", () => {
    expect(UpdateNoteInput.parse({ id: orderId, visibility: "CUSTOMER" })).toEqual({
      id: orderId,
      visibility: "CUSTOMER",
    });
  });

  it("takes a voice memo with its duration", () => {
    const addVoice = new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], "voice.ogg");
    expect(UpdateNoteInput.safeParse({ id: orderId, addVoice, voiceDurationMs: 0 }).success).toBe(
      false,
    );
    expect(UpdateNoteInput.parse({ id: orderId, addVoice, voiceDurationMs: 1000 })).toMatchObject({
      addVoice,
      voiceDurationMs: 1000,
    });
  });
});
