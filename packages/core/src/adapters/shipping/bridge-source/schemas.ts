import { z } from "zod";

// The parts of Bridge Source REST API responses the adapter reads. `GET …/services` was checked
// and `POST …/quote` were checked against the live API (2026-11-03, see __fixtures__/README.md);
// the error categories are still the unverified names from SPEC-carriers' "Bridge Source fit
// check". Unknown fields are dropped.

/** Text we store and show: cut to `max`, so a runaway response can't bloat a row or the UI. */
const text = (max: number) => z.string().transform((value) => value.slice(0, max));
const NAME = 200;

const packageType = z.object({
  /** `<carrier>_custom_package` is the shipper's own box ("Your Packaging"), the one we rate. */
  packageTypeCode: z.string(),
  packageTypeLabel: text(NAME).nullish(),
});

export const serviceSchema = z.object({
  carrierCode: z.string(),
  carrierLabel: text(NAME).nullish(),
  serviceCode: z.string(),
  serviceLabel: text(NAME),
  inbound: z.boolean().nullish(),
  packageTypes: z.array(packageType).nullish(),
  supportedCountries: z.array(z.string()).nullish(),
  unsupportedCountries: z.array(z.string()).nullish(),
});

/** `GET …/services`: a flat list, bare or wrapped. */
export const servicesResponse = z.union([
  z.array(serviceSchema),
  z.object({ services: z.array(serviceSchema) }).transform((body) => body.services),
]);

/** `POST …/quote`: the all-in price (surcharges included) in dollars, sent as a decimal string. */
export const quoteResponse = z.object({
  totalAmount: z
    .union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)])
    .pipe(z.number().finite().nonnegative()),
});

/** Only the structured fields: `error` is free text that can echo the request, so it's never read. */
export const errorResponse = z.object({ errorCategory: z.string().nullish() });
export type ApiError = z.output<typeof errorResponse>;
