import { REPORTS_TODAY_CYCLE_DAYS, type ReportsToday, ReportsTodayInput } from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import { type Actor, assertCan } from "../permissions";
import { cycleTime } from "./cycle-time";
import { isoInZone } from "./exports";

// The home dashboard's report tiles (SPEC-reporting "Home dashboard"): shipped today and the
// 7-day median import → shipped. Both come from one cycle-time read over the last 7 local days,
// so the tiles match Reports → Cycle time for the same range.

/** `day` moved by `days` calendar days; both read as UTC midnight, so DST can't skew it. */
function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** `reports.today`: shipped today (viewer's zone) and the 7-day median cycle time; `report.read`. */
export async function reportsToday(
  db: DbTx,
  actor: Actor,
  input: ReportsTodayInput,
  now = new Date(),
): Promise<ReportsToday> {
  assertCan(actor, "report.read");
  const { timeZone } = ReportsTodayInput.parse(input);
  const today = isoInZone(now, timeZone).slice(0, 10);
  const from = addDays(today, -(REPORTS_TODAY_CYCLE_DAYS - 1));
  const report = await cycleTime(db, actor, { from, to: today, timeZone });
  return {
    today,
    shippedToday: report.byDay.at(-1)?.orders ?? 0,
    medianCycleMs: report.total.medianMs,
  };
}
