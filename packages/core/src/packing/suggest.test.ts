import { describe, expect, it } from "vitest";
import {
  estimateWeightOz,
  FILL_FACTOR,
  type SuggestBox,
  suggestBox,
  weightOffPercent,
} from "./suggest";

const box = (over: Partial<SuggestBox> & { name: string }): SuggestBox => ({
  id: over.name,
  lengthIn: 10,
  widthIn: 8,
  heightIn: 4,
  maxWeightOz: null,
  tareWeightOz: null,
  archived: false,
  ...over,
});
const unit = (over: Partial<Parameters<typeof suggestBox>[0][number]> = {}) => ({
  name: "Yarn",
  lengthIn: 4,
  widthIn: 4,
  heightIn: 3,
  weightOz: 3.5,
  ...over,
});

describe("suggestBox", () => {
  const small = box({ name: "Small", lengthIn: 6, widthIn: 4, heightIn: 2 });
  const medium = box({ name: "Medium" });
  const large = box({ name: "Large", lengthIn: 14, widthIn: 12, heightIn: 8 });

  it("picks the smallest fitting box by inner volume", () => {
    const result = suggestBox([unit()], [large, medium, small]);
    expect(result).toMatchObject({ kind: "box", box: { name: "Medium" } });
  });

  it("breaks volume ties by lower max weight, then name", () => {
    const a = box({ name: "B", maxWeightOz: 100 });
    const b = box({ name: "A", maxWeightOz: 200 });
    const c = box({ name: "C", maxWeightOz: 100 });
    expect(suggestBox([unit()], [b, a, c])).toMatchObject({ box: { name: "B" } });
    expect(suggestBox([unit()], [b, c, a])).toMatchObject({ box: { name: "B" } });
  });

  it("excludes a box when one unit is longer than it, however much volume is free", () => {
    const needle = unit({ lengthIn: 12, widthIn: 1, heightIn: 1 });
    expect(suggestBox([needle], [small, medium, large])).toMatchObject({ box: { name: "Large" } });
  });

  it("compares sorted dimensions, so orientation does not matter", () => {
    const flat = unit({ lengthIn: 3, widthIn: 9, heightIn: 3 });
    expect(suggestBox([flat], [medium])).toMatchObject({ kind: "box" });
  });

  it("limits total unit volume to the fill factor", () => {
    expect(FILL_FACTOR).toBe(0.8);
    // Medium holds 320 in³: 80% is 256. Each unit is 48.
    expect(suggestBox(Array(5).fill(unit()), [medium])).toMatchObject({ kind: "box" });
    expect(suggestBox([unit({ quantity: 5 })], [medium])).toMatchObject({ kind: "box" });
    expect(suggestBox([unit({ quantity: 6 })], [medium])).toEqual({ kind: "split" });
  });

  it("excludes a box when units plus tare exceed its max weight", () => {
    const light = box({ name: "Light", maxWeightOz: 20, tareWeightOz: 5 });
    const heavy = box({ name: "Heavy", lengthIn: 14, widthIn: 12, heightIn: 8, maxWeightOz: 100 });
    // 4 × 3.5 + 5 = 19 fits; 5 × 3.5 + 5 = 22.5 does not.
    expect(suggestBox([unit({ quantity: 4 })], [light, heavy])).toMatchObject({
      box: { name: "Light" },
    });
    expect(suggestBox([unit({ quantity: 5 })], [light, heavy])).toMatchObject({
      box: { name: "Heavy" },
    });
  });

  it("says split when no single box fits", () => {
    expect(suggestBox([unit({ quantity: 100 })], [small, medium, large])).toEqual({
      kind: "split",
    });
    expect(suggestBox([unit()], [])).toEqual({ kind: "split" });
  });

  it("names the items that lack dimensions or weight", () => {
    const result = suggestBox(
      [unit(), unit({ name: "Book", lengthIn: null }), unit({ name: "Hat", weightOz: null })],
      [medium],
    );
    expect(result).toEqual({ kind: "unknown", missing: ["Book", "Hat"] });
  });

  it("never suggests an archived box", () => {
    const old = box({ name: "Old", archived: true });
    expect(suggestBox([unit()], [old])).toEqual({ kind: "split" });
    expect(suggestBox([unit()], [old, large])).toMatchObject({ box: { name: "Large" } });
  });

  it("has no suggestion for no units", () => {
    expect(suggestBox([], [medium])).toEqual({ kind: "none" });
  });

  it("carries the estimated weight of the chosen box", () => {
    const tared = box({ name: "Tared", tareWeightOz: 4 });
    expect(suggestBox([unit({ quantity: 2 })], [tared])).toMatchObject({ estimatedWeightOz: 11 });
  });
});

describe("estimateWeightOz", () => {
  it("sums unit weights plus the tare", () => {
    expect(estimateWeightOz([unit(), unit({ quantity: 2 })], { tareWeightOz: 4 })).toBe(14.5);
  });
  it("counts a missing tare or no box as zero", () => {
    expect(estimateWeightOz([unit()], { tareWeightOz: null })).toBe(3.5);
    expect(estimateWeightOz([unit()], null)).toBe(3.5);
  });
  it("is null when any weight is missing, or there are no units", () => {
    expect(estimateWeightOz([unit(), unit({ weightOz: null })], null)).toBeNull();
    expect(estimateWeightOz([], null)).toBeNull();
  });
});

describe("weightOffPercent", () => {
  it("warns above 25% off in either direction, not within it", () => {
    expect(weightOffPercent(125, 100)).toBeNull();
    expect(weightOffPercent(75, 100)).toBeNull();
    expect(weightOffPercent(126, 100)).toBe(26);
    expect(weightOffPercent(70, 100)).toBe(-30);
  });
  it("never warns without an estimate or a weight", () => {
    expect(weightOffPercent(500, null)).toBeNull();
    expect(weightOffPercent(null, 100)).toBeNull();
  });
});
