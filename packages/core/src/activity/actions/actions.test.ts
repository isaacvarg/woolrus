import { ActivityCategory } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { describe, expect, it } from "vitest";
import { actionMessageKey, actionRegistry, actionSpec } from "./index";

const message = (locale: "en" | "es", key: string) => {
  const action = messages[locale].activity.action as Record<string, string | undefined>;
  return action[key.slice("activity.action.".length)];
};

describe("action registry", () => {
  it("gives every action one of the timeline's categories", () => {
    for (const [action, spec] of Object.entries(actionRegistry)) {
      expect(ActivityCategory.options, action).toContain(spec.category);
    }
  });

  // SPEC-order-activity: Status and Store are worded here; each other category's ticket words its own.
  it.each(["en", "es"] as const)("words every Status and Store action in %s", (locale) => {
    const missing = Object.entries(actionRegistry)
      .filter(([, spec]) => spec.category === "status" || spec.category === "store")
      .map(([action]) => action)
      .filter((action) => !message(locale, actionMessageKey(action)));
    expect(missing).toEqual([]);
  });

  it("never groups status changes, issues, voids, approvals or label purchases", () => {
    for (const action of [
      "stage.move",
      "stage.import",
      "order.claim",
      "issue.report",
      "void.create",
      "approval.grant",
      "label.purchase",
    ]) {
      expect(actionSpec("Order", action)?.groups, action).toBe(false);
    }
  });

  it("looks up an entity-qualified key before the bare action", () => {
    expect(actionSpec("Note", "create")?.category).toBe("notes");
    expect(actionSpec("Box", "create")).toBeUndefined();
  });

  it("turns dotted actions into flat message keys", () => {
    expect(actionMessageKey("order.externalChange.applied")).toBe(
      "activity.action.order_externalChange_applied",
    );
  });
});
