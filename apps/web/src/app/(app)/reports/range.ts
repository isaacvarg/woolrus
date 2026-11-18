import { IsoDate } from "@woolrus/contracts";

// The Reports area's date range (SPEC-reporting "Shared input"), as the URL holds it: a preset by
// name (`?range=30d`), or a custom range by its days (`?range=custom&from=…&to=…`). Days are
// calendar days in the viewer's time zone.

export const rangePresets = ["today", "7d", "30d", "90d", "custom"] as const;
export type RangePreset = (typeof rangePresets)[number];

export const DEFAULT_PRESET = "7d" satisfies RangePreset;

/** The range a view shows: its preset and the inclusive days it resolves to. */
export type RangeView = { preset: RangePreset; from: string; to: string };

/** Days each preset reaches back from today; today is always included. */
const presetDays: Record<Exclude<RangePreset, "custom">, number> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

/** `day` moved by `days` calendar days. Both read as UTC midnight, so DST can't skew it. */
export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Today's date in `timeZone`, YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** The viewer's IANA zone, as the browser reports it. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** A preset's days, ending today. */
export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): RangeView {
  return { preset, from: addDays(today, -presetDays[preset]), to: today };
}

const isPreset = (value: string | null): value is RangePreset =>
  rangePresets.includes(value as RangePreset);
const isDay = (value: string | null): value is string => IsoDate.safeParse(value).success;

/**
 * The range in the URL. Without `range`, a `from`/`to` pair is a custom range; otherwise it's the
 * default. A bad day falls back to the default range's, keeping the rest; the header then shows
 * what the range's checks say about it.
 */
export function readRange(params: URLSearchParams, today: string): RangeView {
  const named = params.get("range");
  const from = params.get("from");
  const to = params.get("to");
  const preset: RangePreset = isPreset(named)
    ? named
    : named === null && (from || to)
      ? "custom"
      : DEFAULT_PRESET;
  if (preset !== "custom") return presetRange(preset, today);
  const fallback = presetRange(DEFAULT_PRESET, today);
  return {
    preset,
    from: isDay(from) ? from : fallback.from,
    to: isDay(to) ? to : fallback.to,
  };
}

/**
 * The query string for `view`, keeping every other param (a report's filters). The default
 * preset is left out, so plain `/reports` is the default view; only a custom range writes its days.
 */
export function rangeSearch(view: RangeView, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  for (const key of ["range", "from", "to"]) next.delete(key);
  if (view.preset !== DEFAULT_PRESET) next.set("range", view.preset);
  if (view.preset === "custom") {
    next.set("from", view.from);
    next.set("to", view.to);
  }
  const search = next.toString();
  return search ? `?${search}` : "";
}
