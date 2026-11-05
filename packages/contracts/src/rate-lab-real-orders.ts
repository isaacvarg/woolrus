import { z } from "zod";
import { Id, QueryBoolean } from "./base";
import { RateSelectionReason } from "./carriers";

// Rate Lab's Real orders dashboard (SPEC-rate-lab "Real orders"): what real packages paid, from
// the quotes rate-history logs. Its route joins `rateLab` in `rate-lab.ts`.

/** A calendar day, YYYY-MM-DD, read in UTC. */
const Day = z.iso.date();

/** The longest range Real orders reads, in days, both ends included: a leap year. */
export const REAL_ORDERS_MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `from`–`to` spans at most REAL_ORDERS_MAX_DAYS. Without `to` the range runs to today, as
 * core reads it; without `from` it is core's last 30 days.
 */
function withinMaxSpan({ from, to }: { from?: string; to?: string }): boolean {
  if (!from) return true;
  const end = to ? Date.parse(to) : Date.parse(new Date().toISOString().slice(0, 10));
  return (end - Date.parse(from)) / DAY_MS + 1 <= REAL_ORDERS_MAX_DAYS;
}

/** The dashboard's input; the CSV export and the PDF report parse the same one. */
export const RealOrdersInput = z
  .object({
    /** Inclusive. Without both, the range is the last 30 days. */
    from: Day.optional(),
    /** Inclusive. */
    to: Day.optional(),
    carrierId: Id.optional(),
    serviceId: Id.optional(),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, "errors.field.country")
      .optional(),
    state: z.string().trim().toUpperCase().max(60).optional(),
    boxId: Id.optional(),
    /** Fake providers' quotes are left out unless asked (SPEC-rate-history decision 6). */
    includeFake: QueryBoolean.default(false),
    /** How many packages the alternatives table shows, newest first; 0 for none (the report). */
    // Coerced: over /api/v1 it arrives as a query string.
    alternativesLimit: z.coerce.number<number>().int().min(0).max(500).default(100),
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    path: ["to"],
    message: "errors.field.dateRange",
  })
  .refine(withinMaxSpan, { path: ["from"], message: "errors.field.dateRangeTooLong" });
export type RealOrdersInput = z.input<typeof RealOrdersInput>;

const Count = z.number().int().nonnegative();
const Cents = z.number().int();

export const RealOrdersReason = z.object({
  /** Null: QA gave no reason. */
  reason: RateSelectionReason.nullable(),
  packages: Count,
  overspendCents: Cents,
});
export type RealOrdersReason = z.infer<typeof RealOrdersReason>;

export const RealOrdersChoice = z.object({
  packages: Count,
  onCheapest: Count,
  notCheapest: Count,
  /** Σ(bought quote − that fetch's cheapest). */
  overspendCents: Cents,
  /** Only the packages not on the cheapest, by reason, largest overspend first. */
  byReason: z.array(RealOrdersReason),
});
export type RealOrdersChoice = z.infer<typeof RealOrdersChoice>;

export const RealOrdersCarrierShare = z.object({
  carrierId: Id,
  name: z.string(),
  packages: Count,
  spendCents: Cents,
});
export type RealOrdersCarrierShare = z.infer<typeof RealOrdersCarrierShare>;

export const RealOrdersServiceShare = z.object({
  serviceId: Id,
  carrierName: z.string(),
  name: z.string(),
  packages: Count,
  spendCents: Cents,
});
export type RealOrdersServiceShare = z.infer<typeof RealOrdersServiceShare>;

/** One lane (country + state) in one week (starting Monday, UTC). */
export const RealOrdersLaneWeek = z.object({
  country: z.string(),
  state: z.string().nullable(),
  week: Day,
  packages: Count,
  medianCents: Cents,
  meanCents: Cents,
});
export type RealOrdersLaneWeek = z.infer<typeof RealOrdersLaneWeek>;

export const RealOrdersOrderCost = z.object({
  orderId: Id,
  number: z.string(),
  costCents: Cents,
  chargedCents: Cents,
});
export type RealOrdersOrderCost = z.infer<typeof RealOrdersOrderCost>;

export const RealOrdersCostVsCharged = z.object({
  orders: Count,
  costCents: Cents,
  chargedCents: Cents,
  overCount: Count,
  /** The orders whose labels cost more than was charged, largest gap first (at most 50). */
  over: z.array(RealOrdersOrderCost),
});
export type RealOrdersCostVsCharged = z.infer<typeof RealOrdersCostVsCharged>;

export const RealOrdersQuote = z.object({
  id: Id,
  carrierName: z.string(),
  serviceName: z.string(),
  amountCents: Cents,
  deliveryDays: z.number().int().nullable(),
  quoteOnly: z.boolean(),
  cheapest: z.boolean(),
  bought: z.boolean(),
});
export type RealOrdersQuote = z.infer<typeof RealOrdersQuote>;

export const RealOrdersPackage = z.object({
  labelId: Id,
  orderId: Id,
  orderNumber: z.string(),
  packageNumber: z.number().int(),
  purchasedAt: z.date(),
  country: z.string(),
  state: z.string().nullable(),
  reason: RateSelectionReason.nullable(),
  /** Cheapest first. */
  quotes: z.array(RealOrdersQuote),
});
export type RealOrdersPackage = z.infer<typeof RealOrdersPackage>;

const Option = z.object({ id: Id, name: z.string() });

export const RealOrders = z.object({
  /** The range read: `from` inclusive, `to` exclusive. */
  from: z.date(),
  to: z.date(),
  choice: RealOrdersChoice,
  byCarrier: z.array(RealOrdersCarrierShare),
  byService: z.array(RealOrdersServiceShare),
  laneCost: z.array(RealOrdersLaneWeek),
  costVsCharged: RealOrdersCostVsCharged,
  alternatives: z.object({ total: Count, packages: z.array(RealOrdersPackage) }),
  /** What the filters can pick from: everything in the range, before the other filters. */
  options: z.object({
    carriers: z.array(Option),
    services: z.array(Option.extend({ carrierId: Id })),
    countries: z.array(z.string()),
    states: z.array(z.object({ country: z.string(), state: z.string() })),
    boxes: z.array(Option),
  }),
});
export type RealOrders = z.infer<typeof RealOrders>;
