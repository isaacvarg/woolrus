import type { QualityIssueView } from "@woolrus/contracts";

export const orderTabs = ["overview", "shipping", "issues", "notes", "history"] as const;
export type OrderTab = (typeof orderTabs)[number];

/** `?tab=` as the page reads it: anything unknown is Overview. */
export function parseOrderTab(value: string | null | undefined): OrderTab {
  return orderTabs.find((tab) => tab === value) ?? "overview";
}

/** The query string for a tab, keeping the other params; Overview is the bare URL. */
export function orderTabSearch(current: string, tab: OrderTab): string {
  const params = new URLSearchParams(current);
  if (tab === "overview") params.delete("tab");
  else params.set("tab", tab);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** What the Issues tab's badge shows: open issues, and whether any of them is Critical. */
export function openIssueSummary(issues: Pick<QualityIssueView, "status" | "severity">[]) {
  const open = issues.filter((issue) => issue.status === "OPEN");
  return { open: open.length, critical: open.some((issue) => issue.severity === "CRITICAL") };
}
