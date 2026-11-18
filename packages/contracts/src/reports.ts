import { z } from "zod";
import { base, Id } from "./base";
import { IssueListInput } from "./issues";
import { OrderListInput, TimeZone } from "./orders";
import { VoidListInput } from "./voids";

// The Reports area and CSV exports (SPEC-reporting "Shared input", "CSV exports"): every report reads
// the same range, in local calendar days of the viewer's time zone.

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

/** Every export writes times in the viewer's zone. */
const InZone = { timeZone: TimeZone.default("UTC") };

/** The All orders list's filters and sort, without paging. */
export const OrdersExportInput = OrderListInput.omit({ page: true, pageSize: true }).extend(InZone);
export type OrdersExportInput = z.input<typeof OrdersExportInput>;

/** The Issues list's filters, without paging. */
export const IssuesExportInput = IssueListInput.omit({ cursor: true, limit: true }).extend(InZone);
export type IssuesExportInput = z.input<typeof IssuesExportInput>;

/** The Voids list's tab and search, without paging. */
export const VoidsExportInput = VoidListInput.omit({ cursor: true, limit: true }).extend(InZone);
export type VoidsExportInput = z.input<typeof VoidsExportInput>;

/** Order lines on orders imported in the range. */
export const OrderItemsExportInput = ReportRange;
export type OrderItemsExportInput = z.input<typeof OrderItemsExportInput>;

// Throughput (FR-REP-01, SPEC-reporting "Throughput"): orders and units per day × stage × person.

/** The stages throughput credits; Shipping is Ready → Completed. */
export const ThroughputStage = z.enum(["PICKING", "PACKING", "QA", "SHIPPING"]);
export type ThroughputStage = z.infer<typeof ThroughputStage>;

/** The person filter: a user, or "system" for work with no actor. */
export const ThroughputPerson = z.union([Id, z.literal("system")]);
export type ThroughputPerson = z.infer<typeof ThroughputPerson>;

export const ThroughputInput = ReportRange.extend({
  stage: ThroughputStage.optional(),
  person: ThroughputPerson.optional(),
});
export type ThroughputInput = z.input<typeof ThroughputInput>;

/** Who did the work; `id` null is the system (no actor). */
export const ThroughputPersonRef = z.object({ id: Id.nullable(), name: z.string().nullable() });
export type ThroughputPersonRef = z.infer<typeof ThroughputPersonRef>;

export const ThroughputRow = z.object({
  /** YYYY-MM-DD in the range's zone. */
  day: IsoDate,
  stage: ThroughputStage,
  person: ThroughputPersonRef,
  /** Orders this person moved out of the stage that day. */
  orders: z.number().int(),
  /** Units this person picked, packed, QA-verified or shipped that day. */
  units: z.number().int(),
});
export type ThroughputRow = z.infer<typeof ThroughputRow>;

export const ThroughputPersonTotal = z.object({
  stage: ThroughputStage,
  person: ThroughputPersonRef,
  orders: z.number().int(),
  units: z.number().int(),
  /** Days in the range with any orders or units for this person in this stage. */
  activeDays: z.number().int(),
});
export type ThroughputPersonTotal = z.infer<typeof ThroughputPersonTotal>;

/** The warehouse row: every day in the range, whatever the filters. */
export const ThroughputDay = z.object({
  day: IsoDate,
  /** Orders imported (their first stage event). */
  imported: z.number().int(),
  /** Orders moved to Completed. */
  shipped: z.number().int(),
});
export type ThroughputDay = z.infer<typeof ThroughputDay>;

export const ThroughputReport = z.object({
  days: z.array(ThroughputDay),
  /** Non-zero cells only, by day, stage, then person; the stage and person filters apply. */
  rows: z.array(ThroughputRow),
  /** The range's totals per person × stage; the filters apply. */
  people: z.array(ThroughputPersonTotal),
  /** Everyone with any throughput in the range, for the person filter (filters don't apply). */
  persons: z.array(ThroughputPersonRef),
});
export type ThroughputReport = z.infer<typeof ThroughputReport>;

/** The throughput CSV takes the screen's range and filters. */
export const ThroughputExportInput = ThroughputInput;
export type ThroughputExportInput = z.input<typeof ThroughputExportInput>;

const tags = ["Reports"];

export const reports = {
  throughput: base
    .route({
      method: "GET",
      path: "/reports/throughput",
      tags,
      summary: "Orders and units per day, stage and person",
    })
    .input(ThroughputInput)
    .output(ThroughputReport),
};
