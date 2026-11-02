import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";

const tags = ["Shipping"];

/** 6–10 digits, dots allowed on the way in; stored (and returned) without them. */
export const HsCode = z
  .string()
  .trim()
  .regex(/^[\d.]+$/, "errors.shipping.hsCodeInvalid")
  .transform((value) => value.replaceAll(".", ""))
  .pipe(z.string().regex(/^\d{6,10}$/, "errors.shipping.hsCodeInvalid"));

/** ISO 3166-1 alpha-2, upper-cased. */
export const CountryOfOrigin = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, "errors.shipping.countryInvalid"));

export const CustomsDescription = z.string().trim().min(1).max(100);

export const CustomsFilter = z.enum(["all", "missing", "international"]);
export type CustomsFilter = z.infer<typeof CustomsFilter>;

export const CustomsProduct = z.object({
  id: Id,
  name: z.string(),
  sku: z.string().nullable(),
  hsCode: z.string().nullable(),
  countryOfOrigin: z.string().nullable(),
  customsDescription: z.string().nullable(),
  /** Missing an HS code or a country of origin: what stops an international label. */
  missing: z.boolean(),
  /** A line of an open order that ships to another country. */
  onInternationalOrder: z.boolean(),
});
export type CustomsProduct = z.infer<typeof CustomsProduct>;

export const CustomsProductsInput = z.object({
  filter: CustomsFilter.default("all"),
  cursor: z.string().max(500).optional(),
});
export type CustomsProductsInput = z.infer<typeof CustomsProductsInput>;

export const CustomsProductsPage = z.object({
  items: z.array(CustomsProduct),
  nextCursor: z.string().nullable(),
});
export type CustomsProductsPage = z.infer<typeof CustomsProductsPage>;

/** Only the fields present change; `null` clears one. */
export const UpdateProductCustomsInput = z.object({
  productId: Id,
  hsCode: HsCode.nullable().optional(),
  countryOfOrigin: CountryOfOrigin.nullable().optional(),
  customsDescription: CustomsDescription.nullable().optional(),
});
export type UpdateProductCustomsInput = z.infer<typeof UpdateProductCustomsInput>;

/** The warehouse's calendar day, YYYY-MM-DD. */
export const ShipDate = z.iso.date();

export const ManifestCandidatesInput = z.object({ shipDate: ShipDate });
export type ManifestCandidatesInput = z.infer<typeof ManifestCandidatesInput>;

export const ManifestSummary = z.object({
  id: Id,
  createdAt: z.date(),
  labelCount: z.number().int(),
});
export type ManifestSummary = z.infer<typeof ManifestSummary>;

export const ManifestCarrier = z.object({
  carrierId: Id,
  /** The carrier account as people know it: its label in Settings, else the provider's name. */
  name: z.string(),
  /** Shipped labels of the day that no manifest covers yet. */
  unmanifested: z.number().int(),
  manifests: z.array(ManifestSummary),
});
export type ManifestCarrier = z.infer<typeof ManifestCarrier>;

export const ManifestCandidates = z.object({
  shipDate: ShipDate,
  carriers: z.array(ManifestCarrier),
});
export type ManifestCandidates = z.infer<typeof ManifestCandidates>;

export const CreateManifestInput = z.object({
  carrierId: Id,
  shipDate: ShipDate,
  idempotencyKey: IdempotencyKey,
});
export type CreateManifestInput = z.infer<typeof CreateManifestInput>;

export const CreateManifestResult = z.object({
  manifestId: Id,
  labelCount: z.number().int(),
});
export type CreateManifestResult = z.infer<typeof CreateManifestResult>;

export const shipping = {
  customsProducts: base
    .route({
      method: "GET",
      path: "/products/customs",
      tags,
      summary: "List products with their customs data",
    })
    .input(CustomsProductsInput)
    .output(CustomsProductsPage),

  updateProductCustoms: base
    .route({
      method: "PATCH",
      path: "/products/{productId}/customs",
      tags,
      summary: "Edit a product's customs data",
    })
    .input(UpdateProductCustomsInput)
    .output(CustomsProduct),

  manifestCandidates: base
    .route({
      method: "GET",
      path: "/manifests/candidates",
      tags,
      summary: "Per carrier account, the day's shipped labels without a manifest",
    })
    .input(ManifestCandidatesInput)
    .output(ManifestCandidates),

  createManifest: base
    .route({
      method: "POST",
      path: "/manifests",
      tags,
      summary: "Manifest a carrier account's shipped labels for a day",
    })
    .input(CreateManifestInput)
    .output(CreateManifestResult),
};
