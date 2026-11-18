import { z } from "zod";
import { base, Id, QueryBoolean } from "./base";
import { IssueListInput, IssueListStatus } from "./issues";
import { SummaryStage } from "./order-activity";
import {
  FulfillmentStage,
  OrderListInput,
  QualityIssueSeverity,
  QualityIssueType,
  TimeZone,
  VoidResolution,
} from "./orders";
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

// ─── Cycle time (FR-REP-02, SPEC-reporting "Cycle time") ──────────────────────────────────────

const Ms = z.number().int().min(0);

/** A duration over the orders that have it, in milliseconds; null figures when `count` is 0. */
export const DurationStat = z.object({
  count: z.number().int().min(0),
  /** The middle value; for an even count, the mean of the two middle ones, rounded. */
  medianMs: Ms.nullable(),
  /** Nearest rank: the smallest value at least 90% of the orders are at or under. */
  p90Ms: Ms.nullable(),
  meanMs: Ms.nullable(),
});
export type DurationStat = z.infer<typeof DurationStat>;

/**
 * One stage over the orders of the cohort that entered it. Each order's intervals are summed, so
 * a repack's two Packing stays count as one longer one. Waiting, working and idle are for work
 * stages only (null for Pending and Ready) and add up to status time.
 */
export const CycleTimeStage = z.object({
  stage: SummaryStage,
  status: DurationStat,
  waiting: DurationStat.nullable(),
  working: DurationStat.nullable(),
  idle: DurationStat.nullable(),
});
export type CycleTimeStage = z.infer<typeof CycleTimeStage>;

/** Orders shipped on one local day of the range, and their median import → shipped. */
export const CycleTimeDay = z.object({
  day: IsoDate,
  orders: z.number().int().min(0),
  medianMs: Ms.nullable(),
});
export type CycleTimeDay = z.infer<typeof CycleTimeDay>;

export const CycleTimeOrder = z.object({
  id: Id,
  number: z.string(),
  importedAt: z.date(),
  shippedAt: z.date(),
  /** Import → shipped, time on hold included. */
  totalMs: Ms,
  onHoldMs: Ms,
});
export type CycleTimeOrder = z.infer<typeof CycleTimeOrder>;

/** How many of the slowest orders the report lists. */
export const CYCLE_TIME_SLOWEST = 20;

/**
 * Orders whose move to Completed falls in the range (an order still open isn't in it). Import →
 * shipped includes holds, which are also reported apart and count in no stage.
 */
export const CycleTimeReport = z.object({
  total: DurationStat,
  /** Over every order in the cohort, so one never held counts as 0. */
  onHold: DurationStat,
  /** Every summary stage, in workflow order. */
  stages: z.array(CycleTimeStage),
  /** Every day of the range, oldest first. */
  byDay: z.array(CycleTimeDay),
  /** The longest import → shipped first; at most CYCLE_TIME_SLOWEST. */
  slowest: z.array(CycleTimeOrder),
});
export type CycleTimeReport = z.infer<typeof CycleTimeReport>;

export const CycleTimeInput = ReportRange;
export type CycleTimeInput = z.input<typeof CycleTimeInput>;

// ─── Quality (FR-QI-07, SPEC-reporting "Quality") ─────────────────────────────────────────────

/** Ranges of at most this many days are bucketed by day; longer ones by week (Monday start). */
export const QUALITY_DAILY_MAX_DAYS = 14;

/** A person's rate per 1,000 units shows only from this many units in the stage. */
export const QUALITY_RATE_MIN_UNITS = 100;

export const QualityBucketSize = z.enum(["day", "week"]);
export type QualityBucketSize = z.infer<typeof QualityBucketSize>;

/** Day buckets for ranges of up to QUALITY_DAILY_MAX_DAYS days, week buckets past that. */
export function qualityBucketSize({ from, to }: { from: string; to: string }): QualityBucketSize {
  return daysBetween(from, to) + 1 <= QUALITY_DAILY_MAX_DAYS ? "day" : "week";
}

/** Where a blocked scan happened (`ScanMiss.stage`). */
export const ScanMissStage = z.enum(["PICKING", "PACKING", "QA"]);
export type ScanMissStage = z.infer<typeof ScanMissStage>;

/** Why a scan was blocked (`ScanMiss.kind`); UNKNOWN_CODE is often a barcode nobody linked yet. */
export const ScanMissKind = z.enum([
  "NOT_ON_ORDER",
  "ALREADY_DONE",
  "OTHER_PACKAGE",
  "UNKNOWN_CODE",
]);
export type ScanMissKind = z.infer<typeof ScanMissKind>;

/** Issues created in the range; the filters apply to issues only, not to scans or voids. */
export const QualityInput = ReportRange.extend({
  severity: QualityIssueSeverity.optional(),
  /** Only issues reported by the customer. */
  customerReported: QueryBoolean.optional(),
  /** `resolved` includes dismissed, as on the Issues list. */
  status: IssueListStatus.default("all"),
});
export type QualityInput = z.input<typeof QualityInput>;

/** Someone on the floor; `id` null is nobody (no responsible user, or a scan with no actor). */
export const QualityPersonRef = z.object({ id: Id.nullable(), name: z.string().nullable() });
export type QualityPersonRef = z.infer<typeof QualityPersonRef>;

/** Issue counts per bucket and over the range, keyed by one dimension. */
function breakdown<K extends z.ZodType>(key: K) {
  return z.object({
    /** Non-zero cells, by bucket then key. */
    series: z.array(z.object({ bucket: IsoDate, key, count: z.number().int() })),
    /** The range's counts, largest first. */
    totals: z.array(z.object({ key, count: z.number().int() })),
  });
}

/** Per responsible person and origin stage: issues, the units they handled there, and the rate. */
export const QualityPersonRate = z.object({
  person: QualityPersonRef,
  /** The issue's origin stage; null when it wasn't recorded. */
  stage: FulfillmentStage.nullable(),
  issues: z.number().int(),
  /** Units this person handled in the stage in the range, as Throughput counts them; null for stages with no units. */
  units: z.number().int().nullable(),
  /** Issues per 1,000 units; null below QUALITY_RATE_MIN_UNITS units. */
  per1000: z.number().nullable(),
});
export type QualityPersonRate = z.infer<typeof QualityPersonRate>;

/** Blocked scans per stage and person, by kind. */
export const QualityScanRow = z.object({
  stage: ScanMissStage,
  person: QualityPersonRef,
  notOnOrder: z.number().int(),
  alreadyDone: z.number().int(),
  otherPackage: z.number().int(),
  /** Kept apart: often a barcode nobody linked yet, not a mistake. */
  unknownCode: z.number().int(),
});
export type QualityScanRow = z.infer<typeof QualityScanRow>;

/** Voids made in the range and not undone, per stage and resolution (null: not resolved yet). */
export const QualityVoidRow = z.object({
  stage: FulfillmentStage,
  resolution: VoidResolution.nullable(),
  voids: z.number().int(),
  units: z.number().int(),
});
export type QualityVoidRow = z.infer<typeof QualityVoidRow>;

export const QualityReport = z.object({
  bucketSize: QualityBucketSize,
  /** Every bucket's first day (a week's Monday, which may be before `from`), oldest first. */
  buckets: z.array(IsoDate),
  /** Issues matching the range and filters. */
  total: z.number().int(),
  byType: breakdown(QualityIssueType),
  byDiscoveredStage: breakdown(FulfillmentStage),
  byOriginStage: breakdown(FulfillmentStage.nullable()),
  /** Keyed by the responsible user's id; null is nobody. Names are in `people`. */
  byPerson: breakdown(Id.nullable()),
  /** One row per responsible person × origin stage, by name. */
  people: z.array(QualityPersonRate),
  /** Blocked scans in the range, by stage then person. */
  scans: z.array(QualityScanRow),
  voids: z.array(QualityVoidRow),
});
export type QualityReport = z.infer<typeof QualityReport>;

/** One row per issue, with the screen's range and filters. */
export const QualityExportInput = QualityInput;
export type QualityExportInput = z.input<typeof QualityExportInput>;

/** One row per blocked scan in the range. */
export const ScanMissesExportInput = ReportRange;
export type ScanMissesExportInput = z.input<typeof ScanMissesExportInput>;

const tags = ["Reports"];

/** The Reports area's reads; each needs `report.read`. */
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
  cycleTime: base
    .route({
      method: "GET",
      path: "/reports/cycle-time",
      tags,
      summary: "How long the orders shipped in a range took, overall and per stage",
    })
    .input(CycleTimeInput)
    .output(CycleTimeReport),
  quality: base
    .route({
      method: "GET",
      path: "/reports/quality",
      tags,
      summary: "Quality issues, blocked scans and voids over a range",
    })
    .input(QualityInput)
    .output(QualityReport),
};
