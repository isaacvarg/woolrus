import { z } from "zod";
import { Id } from "./base";

// Rate Lab's Trends (SPEC-rate-lab "Trends"): how prices for the same test address and parcel move
// across suite runs. Its routes join `rateLab` in `rate-lab.ts`.

/** A calendar day, YYYY-MM-DD, read in UTC. */
const Day = z.iso.date();
const Ids = z.array(Id).max(50).default([]);

const TrendFilters = z.object({
  /** Only quotes from these carriers; empty = all. */
  carrierIds: Ids,
  /** Inclusive, by run time. Without either, every run. */
  from: Day.optional(),
  /** Inclusive. */
  to: Day.optional(),
  /** Fake providers' quotes are left out unless asked (SPEC-rate-history decision 6). */
  includeFake: z.boolean().default(false),
});

const validRange = {
  check: (input: { from?: string; to?: string }) =>
    !input.from || !input.to || input.from <= input.to,
  issue: { path: ["to"], message: "errors.field.dateRange" },
};

export const LabTrendGridInput = TrendFilters.extend({
  /** Addresses in any of these groups; empty = all active. */
  addressGroupIds: Ids,
  /** Parcels in any of these groups; empty = all active. */
  parcelGroupIds: Ids,
}).refine(validRange.check, validRange.issue);
export type LabTrendGridInput = z.input<typeof LabTrendGridInput>;

export const LabTrendSeriesInput = TrendFilters.extend({
  addressId: Id,
  parcelId: Id,
}).refine(validRange.check, validRange.issue);
export type LabTrendSeriesInput = z.input<typeof LabTrendSeriesInput>;

const Cents = z.number().int();

/** The cheapest quote of one combination in one suite run. */
export const LabTrendPrice = z.object({
  runId: Id,
  at: z.date(),
  amountCents: Cents,
  carrierName: z.string(),
  serviceName: z.string(),
  /** No purchasable quote in that run: this is the cheapest quote-only one. */
  quoteOnly: z.boolean(),
});
export type LabTrendPrice = z.infer<typeof LabTrendPrice>;

export const LabTrendCell = z.object({
  addressId: Id,
  parcelId: Id,
  /** Null: no suite run in the filters quoted this combination. */
  latest: LabTrendPrice.nullable(),
  /** The suite run before `latest` that quoted it. */
  previous: LabTrendPrice.nullable(),
  /** (latest − previous) / previous; null without both. */
  change: z.number().nullable(),
});
export type LabTrendCell = z.infer<typeof LabTrendCell>;

const Titled = z.object({ id: Id, title: z.string() });
const Option = z.object({ id: Id, name: z.string() });

export const LabTrendGrid = z.object({
  /** Active, by title: the rows. */
  addresses: z.array(Titled),
  /** Active, by title: the columns. */
  parcels: z.array(Titled),
  /** One per address × parcel, row by row. */
  cells: z.array(LabTrendCell),
  /** Carriers with Rate Lab quotes, for the filter. */
  carriers: z.array(Option),
});
export type LabTrendGrid = z.infer<typeof LabTrendGrid>;

export const LabTrendPoint = z.object({
  runId: Id,
  at: z.date(),
  amountCents: Cents,
  deliveryDays: z.number().int().nullable(),
});
export type LabTrendPoint = z.infer<typeof LabTrendPoint>;

/** One carrier service's price across the suite runs that quoted it. */
export const LabTrendLine = z.object({
  serviceId: Id,
  carrierName: z.string(),
  serviceName: z.string(),
  /** Oldest first. */
  points: z.array(LabTrendPoint),
});
export type LabTrendLine = z.infer<typeof LabTrendLine>;

export const LabTrendSeries = z.object({
  address: Titled.extend({ archived: z.boolean() }),
  parcel: Titled.extend({ archived: z.boolean() }),
  /** Every suite run with a quote in the filters, oldest first. */
  runs: z.array(z.object({ runId: Id, at: z.date() })),
  /** By carrier, then service. */
  lines: z.array(LabTrendLine),
});
export type LabTrendSeries = z.infer<typeof LabTrendSeries>;

// Print-ready reports (SPEC-rate-lab "Exports", decision 10): the pages print what these return.

/** A run report's small chart: each combination's cheapest price over its last this many suite runs. */
export const LAB_RUN_TREND_RUNS = 10;
/** The Trends report charts at most this many combinations and says how many it left out. */
export const LAB_TRENDS_REPORT_MAX = 60;

export const LabRunTrendsInput = z.object({ id: Id });
export type LabRunTrendsInput = z.input<typeof LabRunTrendsInput>;

/** One saved address × parcel of a run, and its cheapest price per suite run up to that run. */
export const LabRunTrend = z.object({
  /** The combination's `addressId:parcelId` key, as run detail has it. */
  key: z.string(),
  /** Oldest first, at most LAB_RUN_TREND_RUNS. */
  prices: z.array(LabTrendPrice),
});
export type LabRunTrend = z.infer<typeof LabRunTrend>;

export const LabTrendsReport = z.object({
  grid: LabTrendGrid,
  /** A chart per combination with data, in grid order, at most LAB_TRENDS_REPORT_MAX. */
  series: z.array(LabTrendSeries),
  /** Combinations with data left out beyond the cap. */
  omitted: z.number().int(),
});
export type LabTrendsReport = z.infer<typeof LabTrendsReport>;
