import { z } from "zod";
import { base, Id } from "./base";

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
};
