import { messages } from "@woolrus/i18n";
import { describe, expect, it } from "vitest";
import { actionMessageKey } from "./index";
import { scanMissActions } from "./scan-misses";

const at = (locale: "en" | "es", action: string) =>
  (messages[locale].activity.action as Record<string, string | undefined>)[
    actionMessageKey(action).slice("activity.action.".length)
  ];

describe("scan miss actions", () => {
  it.each(["en", "es"] as const)("are all worded in %s", (locale) => {
    for (const action of Object.keys(scanMissActions))
      expect(at(locale, action), action).toBeTruthy();
  });

  it("say an unknown code may be a barcode nobody linked yet", () => {
    expect(at("en", "scanMiss.unknownCode")).toContain("nobody has linked yet");
  });

  it("never group and file under Problems", () => {
    for (const spec of Object.values(scanMissActions)) {
      expect(spec).toMatchObject({ category: "problems", groups: false });
    }
  });

  it("target the line, else the box, and name the other box", () => {
    const ctx = {
      lineName: (id: string) => (id === "line-1" ? "Candle" : undefined),
      boxNumber: (id: string) => (id === "pkg-2" ? 2 : undefined),
      packageItem: () => undefined,
      label: () => undefined,
      userName: () => undefined,
    };
    const row = (after: Record<string, string | null>) => ({
      entityType: "ScanMiss",
      entityId: "m",
      action: "scanMiss.otherPackage",
      before: null,
      after: { stage: "QA", code: "C-1", ...after },
    });
    const describe = scanMissActions["scanMiss.otherPackage"].describe;

    expect(describe(row({ orderItemId: "line-1", packageId: "pkg-2" }), ctx)).toEqual({
      params: { stage: "QA", code: "C-1", name: "Candle", batch: "no", box: 2 },
      target: { kind: "line", name: "Candle" },
    });
    expect(describe(row({ packageId: "pkg-2", productName: "Mint" }), ctx).target).toEqual({
      kind: "box",
      number: 2,
    });
  });
});
