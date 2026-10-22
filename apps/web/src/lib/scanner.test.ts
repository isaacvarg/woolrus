import { describe, expect, it } from "vitest";
import { createScanBuffer, isTypingTarget, type ScanKey } from "./scanner";

/** Keys as an HID scanner types them: `gap` ms apart, then Enter. */
function typed(text: string, { start = 1000, gap = 10, target = null as unknown } = {}): ScanKey[] {
  const keys = [...text].map((key, i) => ({ key, time: start + i * gap, target }));
  return [...keys, { key: "Enter", time: start + text.length * gap, target }];
}

function run(keys: ScanKey[]) {
  const scans: string[] = [];
  const buffer = createScanBuffer((code) => scans.push(code));
  const consumed = keys.map((k) => buffer.handle(k));
  return { scans, consumed };
}

/** A stand-in element whose `closest` matches when it sits inside one of `inside`. */
const element = (...inside: string[]) => ({
  closest: (selector: string) =>
    inside.some((s) => selector.split(",").some((part) => part.trim() === s)) ? {} : null,
});

describe("createScanBuffer", () => {
  it("emits the code when Enter ends a fast burst of keys", () => {
    const { scans, consumed } = run(typed("LAV-8OZ"));

    expect(scans).toEqual(["LAV-8OZ"]);
    // Enter is taken, so it doesn't also press the focused button.
    expect(consumed.at(-1)).toBe(true);
  });

  it("starts a new buffer when keys come more than 50 ms apart", () => {
    const keys = [
      ...typed("xy", { start: 0, gap: 10 }).slice(0, 2),
      ...typed("ABC", { start: 200 }),
    ];

    expect(run(keys).scans).toEqual(["ABC"]);
  });

  it("ignores slow typing, ending on Enter, and leaves that Enter alone", () => {
    const { scans, consumed } = run(typed("ABCD", { gap: 120 }));

    expect(scans).toEqual([]);
    expect(consumed.at(-1)).toBe(false);
  });

  it("ignores a lone Enter and very short bursts", () => {
    expect(run([{ key: "Enter", time: 0, target: null }]).scans).toEqual([]);
    expect(run(typed("A")).scans).toEqual([]);
  });

  it("ignores Shift and other non-character keys inside a burst", () => {
    const keys: ScanKey[] = [
      { key: "Shift", time: 0, target: null },
      { key: "L", time: 5, target: null },
      { key: "Shift", time: 10, target: null },
      { key: "A", time: 15, target: null },
      { key: "1", time: 20, target: null },
      { key: "Enter", time: 25, target: null },
    ];

    expect(run(keys).scans).toEqual(["LA1"]);
  });

  it("doesn't hijack keys typed into a field or a dialog", () => {
    expect(run(typed("NOTE", { target: element("input") })).scans).toEqual([]);
    expect(run(typed("NOTE", { target: element("textarea") })).scans).toEqual([]);
    expect(run(typed("NOTE", { target: element('[role="dialog"]') })).scans).toEqual([]);
  });

  it("forgets a burst that moved into a field half way", () => {
    const keys = typed("ABCD").map((k, i) => (i >= 2 ? { ...k, target: element("input") } : k));

    expect(run(keys).scans).toEqual([]);
  });

  it("reads codes one after another", () => {
    expect(run([...typed("AAA", { start: 0 }), ...typed("BBB", { start: 500 })]).scans).toEqual([
      "AAA",
      "BBB",
    ]);
  });
});

describe("isTypingTarget", () => {
  it("is true inside inputs, text areas, selects, editable content and dialogs", () => {
    for (const where of [
      "input",
      "textarea",
      "select",
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[role="dialog"]',
      "dialog",
    ]) {
      expect(isTypingTarget(element(where)), where).toBe(true);
    }
  });

  it("is false for the page and its buttons", () => {
    expect(isTypingTarget(element("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});
