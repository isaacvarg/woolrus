import { z } from "zod";

// The parts of ShipStation API v2 responses the adapter reads, checked against the v2 OpenAPI
// reference (docs.shipstation.com, v2.0.0, 2026-10-27). Unknown fields are dropped.

const money = z.object({ currency: z.string(), amount: z.number() });

export const carriersResponse = z.object({
  carriers: z.array(
    z.object({
      carrier_id: z.string(),
      carrier_code: z.string(),
      friendly_name: z.string().nullish(),
      nickname: z.string().nullish(),
      services: z
        .array(
          z.object({
            service_code: z.string(),
            name: z.string(),
            domestic: z.boolean(),
            international: z.boolean(),
          }),
        )
        .nullish(),
    }),
  ),
});

export const rateSchema = z.object({
  rate_id: z.string().nullish(),
  carrier_id: z.string(),
  service_code: z.string(),
  service_type: z.string(),
  shipping_amount: money,
  insurance_amount: money.nullish(),
  confirmation_amount: money.nullish(),
  other_amount: money.nullish(),
  delivery_days: z.number().int().nullish(),
  estimated_delivery_date: z.coerce.date().nullish(),
  guaranteed_service: z.boolean(),
  trackable: z.boolean(),
});

const apiError = z.object({ error_code: z.string().nullish() });

export const ratesResponse = z.object({
  shipment_id: z.string().nullish(),
  rate_response: z.object({
    shipment_id: z.string().nullish(),
    status: z.string().nullish(),
    rates: z.array(rateSchema),
    errors: z.array(apiError).nullish(),
  }),
});

const validatedAddress = z.object({
  company_name: z.string().nullish(),
  address_line1: z.string(),
  address_line2: z.string().nullish(),
  city_locality: z.string(),
  state_province: z.string(),
  postal_code: z.string(),
  country_code: z.string(),
  address_residential_indicator: z.string().nullish(),
});

export const validateResponse = z
  .array(
    z.object({
      status: z.enum(["unverified", "verified", "warning", "error"]),
      matched_address: validatedAddress.nullish(),
      messages: z.array(z.object({ message: z.string() })).nullish(),
    }),
  )
  .min(1);

export const labelSchema = z.object({
  label_id: z.string(),
  status: z.string(),
  shipment_id: z.string().nullish(),
  external_shipment_id: z.string().nullish(),
  ship_date: z.coerce.date(),
  shipment_cost: money,
  insurance_cost: money.nullish(),
  tracking_number: z.string(),
  carrier_id: z.string(),
  service_code: z.string(),
  label_download: z.object({
    pdf: z.string().nullish(),
    href: z.string().nullish(),
  }),
});

export const labelsResponse = z.object({ labels: z.array(labelSchema) });

export const voidResponse = z.object({
  approved: z.boolean(),
  message: z.string().nullish(),
});

/** ShipStation's error body: `{ request_id, errors: [{ error_code, message, … }] }`. */
export const errorResponse = z.object({ errors: z.array(apiError) });
