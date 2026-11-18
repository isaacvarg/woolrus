"use client";

import type { ReportRange } from "@woolrus/contracts";
import { useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { type RangeView, rangeSearch, readRange, todayIn, viewerTimeZone } from "./range";

const noSubscribe = () => () => {};

/**
 * The viewer's zone. The server renders in UTC and the browser swaps in its own zone once it
 * hydrates, so the two renders agree.
 */
export function useViewerTimeZone(): string {
  return useSyncExternalStore(noSubscribe, viewerTimeZone, () => "UTC");
}

/** The range in the URL, the input every report reads, and a way to change it. */
export function useReportRange(): {
  view: RangeView;
  range: ReportRange;
  /** Today in the viewer's zone, which presets end on. */
  today: string;
  /** The current query string (with its leading `?`, or empty), to carry the view across tabs. */
  search: string;
  setView: (view: RangeView) => void;
} {
  const params = useSearchParams();
  const timeZone = useViewerTimeZone();
  const today = todayIn(timeZone);
  const view = readRange(new URLSearchParams(params), today);
  const search = params.size > 0 ? `?${params.toString()}` : "";
  // Next keeps useSearchParams in step with the History API, without a server round trip. Each
  // change is its own history entry, so Back returns to the previous range.
  const setView = (next: RangeView) =>
    window.history.pushState(null, "", `${window.location.pathname}${rangeSearch(next, params)}`);
  return { view, range: { from: view.from, to: view.to, timeZone }, today, search, setView };
}
