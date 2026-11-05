import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isQueryTrue, QueryBoolean, queryIds, toFieldErrors } from "./base";

function issuesOf(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a validation failure");
  return result.error.issues;
}

describe("toFieldErrors", () => {
  it("keeps message keys written into the schema", () => {
    const schema = z.object({ url: z.string().refine(() => false, "errors.field.invalid") });
    expect(toFieldErrors(issuesOf(schema, { url: "x" }))).toEqual({ url: "errors.field.invalid" });
  });

  it("maps Zod's English messages to keys by issue code", () => {
    const schema = z.object({ a: z.number().positive(), b: z.number().max(5), c: z.string() });
    expect(toFieldErrors(issuesOf(schema, { a: -1, b: 6, c: 1 }))).toEqual({
      a: "errors.field.tooSmall",
      b: "errors.field.tooBig",
      c: "errors.field.invalid",
    });
  });

  it("calls an empty required text 'required', not 'too small'", () => {
    const schema = z.object({ name: z.string().trim().min(1), phone: z.string().min(7) });
    expect(toFieldErrors(issuesOf(schema, { name: "  ", phone: "123" }))).toEqual({
      name: "errors.field.required",
      phone: "errors.field.tooSmall",
    });
  });

  it("joins nested paths with dots and keeps the first issue per field", () => {
    const schema = z.object({
      address: z.object({
        state: z
          .string()
          .length(2)
          .regex(/^[A-Z]+$/),
      }),
    });
    expect(toFieldErrors(issuesOf(schema, { address: { state: "abc" } }))).toEqual({
      "address.state": "errors.field.tooBig",
    });
  });

  it("ignores messages that look like keys but aren't in the catalog", () => {
    const schema = z.object({ a: z.string().refine(() => false, "errors.field.noSuchKey") });
    expect(toFieldErrors(issuesOf(schema, { a: "x" }))).toEqual({ a: "errors.field.invalid" });
  });

  it("accepts Standard Schema path segments ({ key })", () => {
    expect(toFieldErrors([{ message: "nope", path: [{ key: "items" }, { key: 0 }] }])).toEqual({
      "items.0": "errors.field.invalid",
    });
  });

  it("drops issues without a path (the form-level message covers them)", () => {
    expect(toFieldErrors([{ message: "nope" }])).toEqual({});
  });
});

// GET inputs read the same over RPC (real values) and /api/v1 (query-string text).
describe("query inputs", () => {
  it("reads a boolean or its text", () => {
    for (const yes of [true, "true", "1"]) expect(QueryBoolean.parse(yes)).toBe(true);
    for (const no of [false, "false", "0"]) expect(QueryBoolean.parse(no)).toBe(false);
    for (const bad of ["yes", "", 1, null]) expect(QueryBoolean.safeParse(bad).success).toBe(false);
  });

  it("reads a flag from a page's or route's query", () => {
    expect([true, "true", "1"].map(isQueryTrue)).toEqual([true, true, true]);
    expect([false, "false", "0", "yes", undefined, null].map(isQueryTrue)).toEqual(
      Array(6).fill(false),
    );
  });

  it("reads a lone id as a list, and caps the list", () => {
    const a = "01a1a7e8-1159-7098-b4a5-fc9b8586869b";
    expect(queryIds(2).parse(a)).toEqual([a]);
    expect(queryIds(2).parse([a, a])).toEqual([a, a]);
    expect(queryIds(2).safeParse([a, a, a]).success).toBe(false);
    expect(queryIds(2).safeParse("nope").success).toBe(false);
  });
});
