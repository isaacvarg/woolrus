import { describe, expect, it } from "vitest";
import { type CheckPackage, type CheckSettings, evaluateChecks } from "./checks";
import { type SuggestBox, type SuggestUnit, suggestBox } from "./suggest";

// SPEC-packing A1 "Packing checks", success criterion 18.

const settings: CheckSettings = {
  packCheckOverMax: "WARN",
  packCheckWeightOff: "WARN",
  packCheckWeightStale: "WARN",
  packCheckNoFit: "WARN",
  packCheckCustomDimensions: "WARN",
  packCheckWeightOffPercent: 25,
};
const allOff: CheckSettings = {
  ...settings,
  packCheckWeightOff: "OFF",
  packCheckWeightStale: "OFF",
  packCheckNoFit: "OFF",
  packCheckCustomDimensions: "OFF",
};

const small = {
  name: "Small",
  lengthIn: 6,
  widthIn: 4,
  heightIn: 2,
  maxWeightOz: 64,
  tareWeightOz: 0,
};
const large = {
  name: "Large",
  lengthIn: 14,
  widthIn: 12,
  heightIn: 8,
  maxWeightOz: 800,
  tareWeightOz: 0,
};

const pkg = (over: Partial<CheckPackage> = {}): CheckPackage => ({
  box: large,
  dimensions: null,
  weightOz: null,
  overrideReason: null,
  weightStale: false,
  discarded: false,
  ...over,
});
const unit = (over: Partial<SuggestUnit> = {}): SuggestUnit => ({
  name: "Jar",
  lengthIn: null,
  widthIn: null,
  heightIn: null,
  weightOz: 10,
  ...over,
});
const pail = unit({ name: "Pail 5 gal", lengthIn: 7, widthIn: 7, heightIn: 8, weightOz: 40 });

const checks = (p: CheckPackage, units: SuggestUnit[], s: CheckSettings = settings) =>
  evaluateChecks(p, units, s).map((trip) => trip.check);

describe("OVER_MAX", () => {
  it("trips at max + 0.01, not at the max, with the packer's reason", () => {
    const units = [unit({ weightOz: 1 })];
    expect(checks(pkg({ weightOz: 800 }), units, allOff)).toEqual([]);
    expect(
      evaluateChecks(pkg({ weightOz: 800.01, overrideReason: "Dense kit" }), units, allOff),
    ).toEqual([
      {
        check: "OVER_MAX",
        mode: "WARN",
        details: { weightOz: 800.01, maxOz: 800, reason: "Dense kit" },
      },
    ]);
  });

  it("skips a box without a max and a custom size", () => {
    const units = [unit({ weightOz: 1 })];
    expect(
      checks(pkg({ box: { ...large, maxWeightOz: null }, weightOz: 5000 }), units, allOff),
    ).toEqual([]);
    const custom = pkg({ box: null, dimensions: { lengthIn: 10, widthIn: 10, heightIn: 10 } });
    expect(checks({ ...custom, weightOz: 5000 }, units, allOff)).toEqual([]);
  });
});

describe("WEIGHT_OFF", () => {
  // Estimate: 100 oz (no tare).
  const units = [unit({ weightOz: 100 })];

  it("trips past the threshold in either direction, not at it", () => {
    expect(checks(pkg({ weightOz: 125 }), units)).toEqual([]);
    expect(checks(pkg({ weightOz: 75 }), units)).toEqual([]);
    expect(evaluateChecks(pkg({ weightOz: 126 }), units, settings)).toEqual([
      {
        check: "WEIGHT_OFF",
        mode: "WARN",
        details: { weightOz: 126, estimateOz: 100, percent: 26 },
      },
    ]);
    expect(evaluateChecks(pkg({ weightOz: 74 }), units, settings)[0]?.details).toMatchObject({
      percent: -26,
    });
  });

  it("reads the threshold from the setting", () => {
    const tight = { ...settings, packCheckWeightOffPercent: 10 };
    expect(checks(pkg({ weightOz: 110 }), units, tight)).toEqual([]);
    expect(checks(pkg({ weightOz: 111 }), units, tight)).toEqual(["WEIGHT_OFF"]);
  });

  it("counts the box's tare in the estimate", () => {
    const tared = { ...large, tareWeightOz: 20 };
    expect(checks(pkg({ box: tared, weightOz: 150 }), units)).toEqual([]);
  });

  it("needs an estimate: a unit without a weight means no check", () => {
    expect(checks(pkg({ weightOz: 500 }), [...units, unit({ weightOz: null })])).toEqual([]);
    expect(checks(pkg({ weightOz: 500 }), [])).toEqual([]);
  });
});

describe("WEIGHT_STALE", () => {
  it("trips while the contents changed after weighing", () => {
    const units = [unit({ weightOz: 100 })];
    expect(evaluateChecks(pkg({ weightOz: 100, weightStale: true }), units, settings)).toEqual([
      { check: "WEIGHT_STALE", mode: "WARN", details: { weightOz: 100 } },
    ]);
    expect(checks(pkg({ weightOz: 100 }), units)).toEqual([]);
  });
});

describe("NO_FIT", () => {
  it("trips for a pail too tall for Small, not in Large", () => {
    expect(evaluateChecks(pkg({ box: small }), [pail], settings)).toEqual([
      { check: "NO_FIT", mode: "WARN", details: { boxName: "Small", items: ["Pail 5 gal"] } },
    ]);
    expect(checks(pkg({ box: large }), [pail])).toEqual([]);
  });

  it("checks one measured pail among unmeasured jars, which take no space", () => {
    const jars = unit({ quantity: 3 });
    expect(checks(pkg({ box: small }), [pail, jars])).toEqual(["NO_FIT"]);
    expect(checks(pkg({ box: large }), [pail, jars])).toEqual([]);
    // Nothing measured: nothing to check.
    expect(checks(pkg({ box: small }), [jars])).toEqual([]);
  });

  it("names every measured unit when only their total volume is too much", () => {
    const block = unit({ name: "Block", lengthIn: 5, widthIn: 3, heightIn: 2 });
    const trip = evaluateChecks(
      pkg({ box: small }),
      [block, { ...block, name: "Brick" }],
      settings,
    );
    expect(trip).toEqual([
      { check: "NO_FIT", mode: "WARN", details: { boxName: "Small", items: ["Block", "Brick"] } },
    ]);
  });

  it("fit-checks custom dimensions", () => {
    const custom = (lengthIn: number) =>
      pkg({ box: null, dimensions: { lengthIn, widthIn: 7, heightIn: 7 } });
    const noCustom = { ...settings, packCheckCustomDimensions: "OFF" as const };
    expect(evaluateChecks(custom(7), [pail], noCustom)).toEqual([
      { check: "NO_FIT", mode: "WARN", details: { items: ["Pail 5 gal"] } },
    ]);
    expect(checks(custom(12), [pail], noCustom)).toEqual([]);
  });

  // The suggestion and NO_FIT share `fitsIn`, so they can't disagree: a box suggestBox would pick
  // on size (weight aside) is exactly a box NO_FIT accepts.
  it("agrees with suggestBox on every suggestion test case", () => {
    const yarn = { name: "Yarn", lengthIn: 4, widthIn: 4, heightIn: 3, weightOz: 3.5 };
    const boxes = [
      { name: "Small", lengthIn: 6, widthIn: 4, heightIn: 2 },
      { name: "Medium", lengthIn: 10, widthIn: 8, heightIn: 4 },
      { name: "Large", lengthIn: 14, widthIn: 12, heightIn: 8 },
      { name: "Tiny", lengthIn: 1.5, widthIn: 1.5, heightIn: 1.5 },
    ];
    const cases: SuggestUnit[][] = [
      [yarn],
      [{ ...yarn, lengthIn: 12, widthIn: 1, heightIn: 1 }],
      [{ ...yarn, lengthIn: 3, widthIn: 9, heightIn: 3 }],
      Array(5).fill(yarn),
      [{ ...yarn, quantity: 5 }],
      [{ ...yarn, quantity: 6 }],
      [{ ...yarn, quantity: 4 }],
      [{ ...yarn, quantity: 100 }],
      [{ ...yarn, quantity: 2 }],
      [{ name: "Cube", lengthIn: 1, widthIn: 1, heightIn: 1, weightOz: 8 }],
      [pail],
    ];
    for (const units of cases) {
      for (const b of boxes) {
        const box: SuggestBox = {
          ...b,
          id: b.name,
          maxWeightOz: null,
          tareWeightOz: null,
          archived: false,
        };
        const suggested = suggestBox(units, [box]).kind === "box";
        const tripped = checks(pkg({ box: { ...box, maxWeightOz: null } }), units).includes(
          "NO_FIT",
        );
        expect({ units, box: b.name, fits: !tripped }).toEqual({
          units,
          box: b.name,
          fits: suggested,
        });
      }
    }
  });
});

describe("CUSTOM_DIMENSIONS", () => {
  it("trips for a custom size, not for a box", () => {
    const dimensions = { lengthIn: 20, widthIn: 20, heightIn: 20 };
    expect(evaluateChecks(pkg({ box: null, dimensions }), [], settings)).toEqual([
      { check: "CUSTOM_DIMENSIONS", mode: "WARN", details: dimensions },
    ]);
    expect(checks(pkg(), [])).toEqual([]);
  });
});

describe("every check", () => {
  // A package that trips all five: custom size (so no over max), plus a weighed one in a box.
  const tripsAll = pkg({
    box: small,
    weightOz: 200,
    overrideReason: "Heavy",
    weightStale: true,
  });

  it("an unweighed package trips no weight check", () => {
    expect(checks({ ...tripsAll, weightOz: null, overrideReason: null }, [pail])).toEqual([
      "NO_FIT",
    ]);
  });

  it("a check set to off never trips", () => {
    expect(checks(tripsAll, [pail])).toEqual(["OVER_MAX", "WEIGHT_OFF", "WEIGHT_STALE", "NO_FIT"]);
    expect(checks(tripsAll, [pail], allOff)).toEqual(["OVER_MAX"]);
    const custom = pkg({ box: null, dimensions: { lengthIn: 1, widthIn: 1, heightIn: 1 } });
    expect(checks(custom, [pail], allOff)).toEqual([]);
  });

  it("carries the mode from the setting", () => {
    const blocking = { ...settings, packCheckNoFit: "BLOCK" as const };
    expect(evaluateChecks(pkg({ box: small }), [pail], blocking)[0]?.mode).toBe("BLOCK");
  });

  it("never checks a discarded package", () => {
    expect(checks({ ...tripsAll, discarded: true }, [pail])).toEqual([]);
  });
});
