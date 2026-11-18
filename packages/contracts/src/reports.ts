import { z } from "zod";
import { TimeZone } from "./orders";

// The Reports area (SPEC-reporting "Shared input"): every report reads the same range, in local
// calendar days of the viewer's time zone.

/** The longest range a report reads on screen: `to` at most this many days after `from`. */
export const REPORT_RANGE_MAX_DAYS = 92;

/** A calendar day, YYYY-MM-DD, in the range's time zone. */
export const IsoDate = z.iso.date({ message: "errors.field.invalid" });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole calendar days from `from` to `to`; both parse as UTC midnight, so DST can't skew it. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** Both ends are real days; otherwise the day fields already carry the error. */
const bothDays = ({ from, to }: { from: string; to: string }) =>
  IsoDate.safeParse(from).success && IsoDate.safeParse(to).success;

export const ReportRange = z
  .object({
    /** Inclusive, in `timeZone`. */
    from: IsoDate,
    /** Inclusive, in `timeZone`; at most REPORT_RANGE_MAX_DAYS after `from`. */
    to: IsoDate,
    /** The viewer's IANA zone, as `orders.dailyActivity` takes it. */
    timeZone: TimeZone,
  })
  .refine((range) => !bothDays(range) || range.from <= range.to, {
    path: ["to"],
    message: "errors.field.dateRange",
  })
  .refine(
    (range) => !bothDays(range) || daysBetween(range.from, range.to) <= REPORT_RANGE_MAX_DAYS,
    { path: ["to"], message: "errors.field.reportRangeTooLong" },
  );
export type ReportRange = z.infer<typeof ReportRange>;
