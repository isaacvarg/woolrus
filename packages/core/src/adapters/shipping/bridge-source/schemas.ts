import { z } from "zod";

// The parts of Bridge Source REST API responses the adapter reads. Field names follow
// SPEC-carriers' "Bridge Source fit check" (API Documentation (Rest & CORE), 2026-07-21). That
// document is not in the repo and was not reachable when this was written, so the names are NOT
// yet verified against it: see __fixtures__/README.md. Unknown fields are dropped.

/** Text we store and show: cut to `max`, so a runaway response can't bloat a row or the UI. */
const text = (max: number) => z.string().transform((value) => value.slice(0, max));
const NAME = 200;

const packageType = z.object({
  packageTypeCode: z.string(),
  /** Marks the type for the shipper's own box ("custom packaging"), the one we rate. */
  custom: z.boolean().nullish(),
  name: text(NAME).nullish(),
});

export const serviceSchema = z.object({
  carrierCode: z.string(),
  carrierName: text(NAME).nullish(),
  serviceCode: z.string(),
  serviceName: text(NAME),
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

/** Only the structured fields: `error` is free text that can echo the request, so it's never read. */
export const errorResponse = z.object({ errorCategory: z.string().nullish() });
export type ApiError = z.output<typeof errorResponse>;
