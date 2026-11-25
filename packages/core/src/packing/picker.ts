// The pack screen's box picker layout (SPEC-packing A2 "Box picker layout"). Pure, so the dialog
// can arrange whichever suggestion it shows (the order's for Add package, the package's for Change
// box) without another request. Exported as `@woolrus/core/picker` for the client.

export type PickerBox = { id: string; name: string; groupId: string | null; archived: boolean };
export type PickerGroup = { id: string; name: string; position: number };
/** Only a `box` suggestion names a box; split, unknown and none put nothing on top. */
export type PickerSuggestion = { kind: "box"; box: { id: string } } | { kind: string };

export type PickerSection<B, G> = { group: G | null; boxes: B[] };
export type PickerLayout<B, G> = { suggested: B | null; sections: PickerSection<B, G>[] };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function arrangeBoxPicker<B extends PickerBox, G extends PickerGroup>(
  boxes: readonly B[],
  groups: readonly G[],
  suggestion: PickerSuggestion,
): PickerLayout<B, G> {
  const active = boxes.filter((box) => !box.archived).sort(byName);
  const suggestedId = "box" in suggestion ? suggestion.box.id : null;
  // Shown once, on top (decision 30), and only if it's still an active box.
  const suggested = active.find((box) => box.id === suggestedId) ?? null;
  const rest = active.filter((box) => box !== suggested);

  const known = new Set(groups.map((group) => group.id));
  const sections: PickerSection<B, G>[] = [...groups]
    .sort((a, b) => a.position - b.position || byName(a, b))
    .map((group) => ({ group, boxes: rest.filter((box) => box.groupId === group.id) }))
    // A group with nothing to show is hidden (decision 33).
    .filter((section) => section.boxes.length > 0);

  // Ungrouped boxes come last (decision 29); a stale groupId counts as ungrouped.
  const other = rest.filter((box) => box.groupId === null || !known.has(box.groupId));
  if (other.length > 0) sections.push({ group: null, boxes: other });
  return { suggested, sections };
}
