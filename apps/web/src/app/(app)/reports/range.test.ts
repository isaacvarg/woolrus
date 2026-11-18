import { describe, expect, it } from "vitest";
import { rangeSearch, readRange, todayIn } from "./range";

const today = "2026-11-18";
const read = (query: string) => readRange(new URLSearchParams(query), today);

describe("readRange", () => {
  it("defaults to the last 7 days, today included", () => {
    expect(read("")).toEqual({ preset: "7d", from: "2026-11-12", to: today });
  });

  it("resolves each preset against today", () => {
    expect(read("range=today")).toEqual({ preset: "today", from: today, to: today });
    expect(read("range=30d")).toEqual({ preset: "30d", from: "2026-10-20", to: today });
    expect(read("range=90d")).toEqual({ preset: "90d", from: "2026-08-21", to: today });
  });

  it("reads a custom range's days, also without the range param", () => {
    const custom = { preset: "custom", from: "2026-10-01", to: "2026-10-31" };
    expect(read("range=custom&from=2026-10-01&to=2026-10-31")).toEqual(custom);
    expect(read("from=2026-10-01&to=2026-10-31")).toEqual(custom);
  });

  it("falls back to the default for an unknown preset or a malformed day", () => {
    expect(read("range=year")).toEqual({ preset: "7d", from: "2026-11-12", to: today });
    expect(read("range=custom&from=yesterday&to=2026-10-31")).toEqual({
      preset: "custom",
      from: "2026-11-12",
      to: "2026-10-31",
    });
  });
});

describe("rangeSearch", () => {
  it("leaves the default out, so plain /reports is the default view", () => {
    expect(
      rangeSearch({ preset: "7d", from: "2026-11-12", to: today }, new URLSearchParams()),
    ).toBe("");
  });

  it("writes a preset by name and a custom range by its days, keeping other filters", () => {
    const params = new URLSearchParams("stage=PACKING&from=2026-01-01&to=2026-01-02");
    expect(rangeSearch({ preset: "30d", from: "2026-10-20", to: today }, params)).toBe(
      "?stage=PACKING&range=30d",
    );
    expect(rangeSearch({ preset: "custom", from: "2026-10-01", to: "2026-10-31" }, params)).toBe(
      "?stage=PACKING&range=custom&from=2026-10-01&to=2026-10-31",
    );
  });

  it("round-trips through readRange, so a reload keeps the view", () => {
    for (const view of [
      { preset: "today", from: today, to: today },
      { preset: "90d", from: "2026-08-21", to: today },
      { preset: "custom", from: "2026-09-01", to: "2026-09-30" },
    ] as const) {
      expect(read(rangeSearch(view, new URLSearchParams()).slice(1))).toEqual(view);
    }
  });
});

describe("todayIn", () => {
  it("is the calendar day in the viewer's zone, not UTC's", () => {
    // 03:30 UTC on the 19th is still the evening of the 18th in Chicago.
    const at = new Date("2026-11-19T03:30:00Z");
    expect(todayIn("America/Chicago", at)).toBe("2026-11-18");
    expect(todayIn("UTC", at)).toBe("2026-11-19");
  });
});
