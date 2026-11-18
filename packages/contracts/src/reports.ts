import { z } from "zod";
import { IssueListInput } from "./issues";
import { OrderListInput, TimeZone } from "./orders";
import { VoidListInput } from "./voids";

// Reports and CSV exports (SPEC-reporting "Shared input", "CSV exports").

export const IsoDate = z.iso.date();

/** The longest range a report reads; longer history comes from CSV in pieces. */
export const REPORT_RANGE_MAX_DAYS = 92;

const dayMs = 86_400_000;

/** Days `from` through `to`, both inclusive, as calendar days in `timeZone`. */
export const ReportRange = z.object({ from: IsoDate, to: IsoDate, timeZone: TimeZone }).refine(
  ({ from, to }) => {
    const days = (Date.parse(to) - Date.parse(from)) / dayMs;
    return days >= 0 && days <= REPORT_RANGE_MAX_DAYS;
  },
  { message: "errors.field.invalid", path: ["to"] },
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
