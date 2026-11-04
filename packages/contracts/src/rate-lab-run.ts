import { z } from "zod";
import { Id } from "./base";
import { RateError, ShippingProviderId } from "./carriers";

// A Rate Lab run's page (SPEC-rate-lab "Run detail", "Insights"): every quote by address × parcel,
// and what they say. The route and `LabRunDetail` join `rateLab` in `rate-lab.ts`.

/** One quote of a run, as rate history logged it. */
export const LabQuote = z.object({
  id: Id,
  provider: ShippingProviderId,
  carrierId: Id,
  /** The account's label when set, else the carrier's name. */
  carrierName: z.string(),
  serviceId: Id,
  serviceCode: z.string(),
  serviceName: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  deliveryDays: z.number().int().nullable(),
  guaranteed: z.boolean(),
  /** The provider couldn't buy it when quoted. */
  quoteOnly: z.boolean(),
  fake: z.boolean(),
});
export type LabQuote = z.infer<typeof LabQuote>;

const Titled = z.object({ id: Id, title: z.string() });

/** One address × parcel of a run: its fetch's quotes (cheapest first) and provider errors. */
export const LabCombination = z.object({
  /** `addressId:parcelId`, or the fetch id when either was typed in (one-off quotes). */
  key: z.string(),
  fetchId: Id,
  /** Null when typed in rather than saved. */
  address: Titled.nullable(),
  parcel: Titled.nullable(),
  lane: z.object({ country: z.string(), state: z.string().nullable() }),
  quotes: z.array(LabQuote),
  errors: z.array(RateError),
  /** The earlier suite run its prices are compared with, if any. */
  comparedWith: z.object({ runId: Id, createdAt: z.date() }).nullable(),
});
export type LabCombination = z.infer<typeof LabCombination>;

/** A combination's cheapest and fastest, from purchasable quotes when it has any. */
export const LabPick = z.object({
  key: z.string(),
  cheapestId: Id.nullable(),
  /** Nothing could be bought, so the pick is a quote-only quote. */
  cheapestQuoteOnly: z.boolean(),
  fastestId: Id.nullable(),
  fastestQuoteOnly: z.boolean(),
  /** No quotes at all. */
  failed: z.boolean(),
});
export type LabPick = z.infer<typeof LabPick>;

export const LabPriceMoveKind = z.enum(["CHANGED", "NEW", "MISSING"]);

/** A carrier service whose price moved enough since the compared run, or that came or went. */
export const LabPriceMove = z.object({
  combinationKey: z.string(),
  kind: LabPriceMoveKind,
  carrierId: Id,
  carrierName: z.string(),
  serviceId: Id,
  serviceName: z.string(),
  previousCents: z.number().int().nullable(),
  currentCents: z.number().int().nullable(),
  /** Signed, e.g. -12.5; null for new and missing services. */
  changePct: z.number().nullable(),
});
export type LabPriceMove = z.infer<typeof LabPriceMove>;

export const LabCarrierWin = z.object({
  carrierId: Id,
  carrierName: z.string(),
  serviceId: Id,
  serviceName: z.string(),
  /** Combinations it was cheapest for. */
  wins: z.number().int(),
});
export type LabCarrierWin = z.infer<typeof LabCarrierWin>;

/** A provider's errors in the run; `provider` null when no provider was called (customs). */
export const LabProviderFailures = z.object({
  provider: ShippingProviderId.nullable(),
  count: z.number().int(),
  errors: z.array(
    RateError.pick({ messageKey: true, params: true }).extend({ combinationKey: z.string() }),
  ),
});
export type LabProviderFailures = z.infer<typeof LabProviderFailures>;

export const LabRunInsights = z.object({
  picks: z.array(LabPick),
  moves: z.array(LabPriceMove),
  carrierWins: z.array(LabCarrierWin),
  failures: z.array(LabProviderFailures),
});
export type LabRunInsights = z.infer<typeof LabRunInsights>;
