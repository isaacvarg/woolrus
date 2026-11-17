import { describe, expect, it } from "vitest";
import { openIssueSummary, orderTabSearch, parseOrderTab } from "./order-tab";

describe("parseOrderTab", () => {
  it("reads a known tab", () => {
    expect(parseOrderTab("notes")).toBe("notes");
    expect(parseOrderTab("history")).toBe("history");
  });

  it("falls back to Overview for a missing or unknown tab", () => {
    expect(parseOrderTab(null)).toBe("overview");
    expect(parseOrderTab("")).toBe("overview");
    expect(parseOrderTab("labels")).toBe("overview");
  });
});

describe("orderTabSearch", () => {
  it("sets the tab and keeps other params", () => {
    expect(orderTabSearch("?from=queue", "issues")).toBe("?from=queue&tab=issues");
  });

  it("drops the param for Overview", () => {
    expect(orderTabSearch("?tab=notes", "overview")).toBe("");
    expect(orderTabSearch("?tab=notes&from=queue", "overview")).toBe("?from=queue");
  });
});

describe("openIssueSummary", () => {
  it("counts open issues only and flags a Critical one", () => {
    expect(
      openIssueSummary([
        { status: "OPEN", severity: "MINOR" },
        { status: "RESOLVED", severity: "CRITICAL" },
        { status: "OPEN", severity: "MAJOR" },
      ]),
    ).toEqual({ open: 2, critical: false });
    expect(
      openIssueSummary([
        { status: "OPEN", severity: "CRITICAL" },
        { status: "DISMISSED", severity: "MINOR" },
      ]),
    ).toEqual({ open: 1, critical: true });
  });
});
