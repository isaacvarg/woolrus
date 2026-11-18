import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toFieldErrors } from "./base";
import { QualityInput, qualityBucketSize, REPORT_RANGE_MAX_DAYS, ReportRange } from "./reports";

function fieldsOf(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a validation failure");
  return toFieldErrors(result.error.issues);
}

describe("ReportRange", () => {
  it("takes inclusive local days and the viewer's zone", () => {
    expect(
      ReportRange.parse({ from: "2026-11-01", to: "2026-11-07", timeZone: "America/Chicago" }),
    ).toEqual({ from: "2026-11-01", to: "2026-11-07", timeZone: "America/Chicago" });
  });

  it("allows a single day", () => {
    expect(
      ReportRange.safeParse({ from: "2026-11-18", to: "2026-11-18", timeZone: "UTC" }).success,
    ).toBe(true);
  });

  it("allows to up to 92 days after from, and refuses one more", () => {
    expect(REPORT_RANGE_MAX_DAYS).toBe(92);
    // 2026-01-01 + 92 days = 2026-04-03.
    expect(
      ReportRange.safeParse({ from: "2026-01-01", to: "2026-04-03", timeZone: "UTC" }).success,
    ).toBe(true);
    expect(
      fieldsOf(ReportRange, { from: "2026-01-01", to: "2026-04-04", timeZone: "UTC" }),
    ).toEqual({
      to: "errors.field.reportRangeTooLong",
    });
  });

  it("counts days on the calendar, not in hours, across a DST change", () => {
    // Chicago springs forward on 2026-03-08; the span is still 92 calendar days.
    expect(
      ReportRange.safeParse({ from: "2026-02-01", to: "2026-05-04", timeZone: "America/Chicago" })
        .success,
    ).toBe(true);
  });

  it("refuses an end before the start", () => {
    expect(
      fieldsOf(ReportRange, { from: "2026-11-07", to: "2026-11-01", timeZone: "UTC" }),
    ).toEqual({
      to: "errors.field.dateRange",
    });
  });

  it("refuses a malformed day or an unknown zone", () => {
    expect(
      fieldsOf(ReportRange, { from: "2026-13-01", to: "2026-11-01", timeZone: "Mars/Olympus" }),
    ).toEqual({
      from: "errors.field.invalid",
      timeZone: "errors.field.invalid",
    });
    expect(
      fieldsOf(ReportRange, { from: "11/01/2026", to: "2026-11-01", timeZone: "UTC" }),
    ).toEqual({
      from: "errors.field.invalid",
    });
  });

  it("needs every field", () => {
    expect(Object.keys(fieldsOf(ReportRange, {})).sort()).toEqual(["from", "timeZone", "to"]);
  });
});

describe("QualityInput", () => {
  const range = { from: "2026-11-01", to: "2026-11-30", timeZone: "UTC" };

  it("defaults to every status and reads the customer-reported flag from a query string", () => {
    expect(QualityInput.parse(range)).toEqual({ ...range, status: "all" });
    expect(QualityInput.parse({ ...range, customerReported: "true" }).customerReported).toBe(true);
    expect(QualityInput.parse({ ...range, customerReported: false }).customerReported).toBe(false);
  });

  it("buckets by day up to 14 days, then by week", () => {
    expect(qualityBucketSize({ from: "2026-11-01", to: "2026-11-14" })).toBe("day");
    expect(qualityBucketSize({ from: "2026-11-01", to: "2026-11-15" })).toBe("week");
    expect(qualityBucketSize({ from: "2026-11-18", to: "2026-11-18" })).toBe("day");
  });
});
