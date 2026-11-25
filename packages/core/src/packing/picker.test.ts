import { describe, expect, it } from "vitest";
import { arrangeBoxPicker, type PickerBox, type PickerGroup } from "./picker";

// SPEC-packing A2, criterion 31: the box picker's layout.

const box = (name: string, groupId: string | null, over: Partial<PickerBox> = {}): PickerBox => ({
  id: name,
  name,
  groupId,
  archived: false,
  ...over,
});
const group = (id: string, position: number): PickerGroup => ({ id, name: id, position });

const mailers = group("Mailers", 1);
const cartons = group("Cartons", 0);
const pails = group("Pails", 2);

const names = (sections: ReturnType<typeof arrangeBoxPicker>["sections"]) =>
  sections.map((s) => [s.group?.name ?? null, s.boxes.map((b) => b.name)]);

describe("arrangeBoxPicker (criterion 31)", () => {
  const boxes = [
    box("Small mailer", "Mailers"),
    box("Bubble mailer", "Mailers"),
    box("Medium carton", "Cartons"),
    box("Large carton", "Cartons"),
    box("Large box", null),
    box("Flat", null),
  ];

  it("puts the suggested box on top and in no section", () => {
    const result = arrangeBoxPicker(boxes, [mailers, cartons], {
      kind: "box",
      box: { id: "Medium carton" },
    });
    expect(result.suggested?.name).toBe("Medium carton");
    expect(result.sections.flatMap((s) => s.boxes).map((b) => b.name)).not.toContain(
      "Medium carton",
    );
  });

  it("orders groups by position with boxes A–Z inside, then the ungrouped boxes", () => {
    const result = arrangeBoxPicker(boxes, [mailers, cartons], { kind: "none" });
    expect(result.suggested).toBeNull();
    expect(names(result.sections)).toEqual([
      ["Cartons", ["Large carton", "Medium carton"]],
      ["Mailers", ["Bubble mailer", "Small mailer"]],
      [null, ["Flat", "Large box"]],
    ]);
  });

  it("breaks a position tie by name, as the Boxes page lists them", () => {
    const tied = [group("B", 0), group("A", 0)];
    const result = arrangeBoxPicker([box("x", "B"), box("y", "A")], tied, { kind: "none" });
    expect(names(result.sections)).toEqual([
      ["A", ["y"]],
      ["B", ["x"]],
    ]);
  });

  it("drops groups that are empty, all archived, or hold only the suggestion", () => {
    const result = arrangeBoxPicker(
      [
        box("Small mailer", "Mailers", { archived: true }),
        box("Medium carton", "Cartons"),
        box("Large box", null),
      ],
      [mailers, cartons, pails],
      { kind: "box", box: { id: "Medium carton" } },
    );
    expect(result.suggested?.name).toBe("Medium carton");
    expect(names(result.sections)).toEqual([[null, ["Large box"]]]);
  });

  it("gives exactly one ungrouped section when there are no groups", () => {
    const result = arrangeBoxPicker([box("B", null), box("A", null)], [], { kind: "none" });
    expect(names(result.sections)).toEqual([[null, ["A", "B"]]]);
  });

  it("leaves out the ungrouped section when every box has a group", () => {
    const result = arrangeBoxPicker([box("A", "Mailers")], [mailers], { kind: "none" });
    expect(names(result.sections)).toEqual([["Mailers", ["A"]]]);
  });

  it("has no suggested box for a split or unknown suggestion", () => {
    for (const suggestion of [{ kind: "split" }, { kind: "unknown" }] as const) {
      const result = arrangeBoxPicker(boxes, [mailers, cartons], suggestion);
      expect(result.suggested).toBeNull();
      expect(result.sections.flatMap((s) => s.boxes)).toHaveLength(boxes.length);
    }
  });

  it("never shows an archived box, even when it is the suggestion or ungrouped", () => {
    const result = arrangeBoxPicker(
      [box("Old", null, { archived: true }), box("Gone", "Cartons", { archived: true })],
      [cartons],
      { kind: "box", box: { id: "Gone" } },
    );
    expect(result.suggested).toBeNull();
    expect(result.sections).toEqual([]);
  });

  it("puts a box whose group no longer exists with the ungrouped boxes", () => {
    const result = arrangeBoxPicker([box("A", "Deleted")], [], { kind: "none" });
    expect(names(result.sections)).toEqual([[null, ["A"]]]);
  });
});
