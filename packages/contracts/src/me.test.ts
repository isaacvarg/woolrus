import { describe, expect, it } from "vitest";
import { Preferences, UpdatePreferencesInput } from "./me";

describe("boxPickerColumns (SPEC-packing A2, criterion 32)", () => {
  it("accepts 1 and 2", () => {
    for (const boxPickerColumns of [1, 2]) {
      expect(UpdatePreferencesInput.parse({ boxPickerColumns })).toEqual({ boxPickerColumns });
    }
  });

  it("refuses anything else", () => {
    for (const boxPickerColumns of [0, 3, 1.5, "2"]) {
      expect(UpdatePreferencesInput.safeParse({ boxPickerColumns }).success).toBe(false);
    }
  });

  it("is part of the saved preferences", () => {
    expect(Preferences.shape.boxPickerColumns).toBeDefined();
  });
});
