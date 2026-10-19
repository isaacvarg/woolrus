import { z } from "zod";
import { StoreError } from "./errors";

// Only the fields sync reads are typed; everything else stays in `raw`, the object exactly as
// WooCommerce sent it, which is what gets stored in `rawPayload`. Woo sends "" for unset text,
// numbers as strings (and line prices as numbers), and GMT timestamps without a zone.

/** Text where "" means unset. */
const text = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null));

/** A decimal amount, kept as a string so money is never a float (T2 converts to cents). */
const decimal = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === "" ? null : String(v)));

const gmtDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  .transform((v) => new Date(`${v}Z`));

const metaSchema = z
  .object({
    key: z.string(),
    value: z.unknown(),
    display_key: z.string().optional(),
    display_value: z.unknown().optional(),
  })
  .transform((m) => ({
    key: m.key,
    value: m.value,
    displayKey: m.display_key ?? m.key,
    displayValue: m.display_value ?? m.value,
  }));

const addressSchema = z
  .object({
    first_name: text,
    last_name: text,
    company: text,
    address_1: text,
    address_2: text,
    city: text,
    state: text,
    postcode: text,
    country: text,
    email: text,
    phone: text,
  })
  .transform((a) => ({
    firstName: a.first_name,
    lastName: a.last_name,
    company: a.company,
    address1: a.address_1,
    address2: a.address_2,
    city: a.city,
    state: a.state,
    postcode: a.postcode,
    country: a.country,
    email: a.email,
    phone: a.phone,
  }));

const imageSrc = z
  .object({ src: text })
  .nullish()
  .transform((i) => i?.src ?? null);

/** A line item id sent as a number or a string; "" and 0 mean none. */
const lineId = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) =>
    v === null || v === undefined || v === "" || Number(v) === 0 ? null : Number(v),
  )
  .pipe(z.number().int().nullable());

const dimensionsSchema = z.object({ length: decimal, width: decimal, height: decimal });

const lineItemSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    product_id: z.number().int(),
    variation_id: z.number().int(),
    quantity: z.number().int(),
    sku: text,
    price: decimal,
    total: decimal,
    image: z.unknown().optional(),
    meta_data: z.array(metaSchema),
    // Product Bundles adds the bundle line's id to each bundled line.
    bundled_by: lineId,
  })
  .transform((l) => ({
    id: l.id,
    name: l.name,
    productId: l.product_id,
    variationId: l.variation_id,
    quantity: l.quantity,
    sku: l.sku,
    price: l.price,
    total: l.total,
    imageSrc: imageSrc.parse(l.image),
    metaData: l.meta_data,
    bundledBy: l.bundled_by,
  }));

const orderSchema = z
  .object({
    id: z.number().int(),
    number: z.string(),
    status: z.string(),
    currency: z.string(),
    total: z.string(),
    customer_note: text,
    payment_method_title: text,
    date_created_gmt: gmtDate,
    date_modified_gmt: gmtDate,
    billing: addressSchema,
    shipping: addressSchema,
    shipping_lines: z.array(
      z.object({ method_title: text, total: decimal }).transform((s) => ({
        methodTitle: s.method_title,
        total: s.total,
      })),
    ),
    // Older payloads and some fixtures omit it; nothing is lost by reading it as none.
    fee_lines: z.array(z.object({ name: text, total: decimal })).default([]),
    line_items: z.array(lineItemSchema),
    refunds: z.array(z.object({ id: z.number().int(), total: decimal })),
    meta_data: z.array(metaSchema),
  })
  .transform((o) => ({
    id: o.id,
    number: o.number,
    status: o.status,
    currency: o.currency,
    total: o.total,
    customerNote: o.customer_note,
    paymentMethodTitle: o.payment_method_title,
    dateCreatedGmt: o.date_created_gmt,
    dateModifiedGmt: o.date_modified_gmt,
    billing: o.billing,
    shipping: o.shipping,
    shippingLines: o.shipping_lines,
    feeLines: o.fee_lines,
    lineItems: o.line_items,
    refunds: o.refunds,
    metaData: o.meta_data,
  }));

const productFields = {
  id: z.number().int(),
  sku: text,
  price: decimal,
  weight: decimal,
  dimensions: dimensionsSchema,
  stock_quantity: z.number().nullish(),
  virtual: z.boolean(),
  // GTIN/UPC/EAN/ISBN (WooCommerce 9.2+); older stores don't send it.
  global_unique_id: text,
  meta_data: z.array(metaSchema),
};

const productSchema = z
  .object({
    ...productFields,
    type: z.string(),
    name: z.string(),
    images: z.array(z.object({ src: text })),
  })
  .transform((p) => ({
    id: p.id,
    type: p.type,
    name: p.name,
    sku: p.sku,
    price: p.price,
    weight: p.weight,
    dimensions: p.dimensions,
    stockQuantity: p.stock_quantity ?? null,
    virtual: p.virtual,
    globalUniqueId: p.global_unique_id,
    imageSrc: p.images[0]?.src ?? null,
    metaData: p.meta_data,
  }));

const variationSchema = z
  .object({
    ...productFields,
    name: text,
    image: z.unknown().optional(),
    attributes: z.array(z.object({ name: z.string(), option: z.string() })),
  })
  .transform((v) => ({
    id: v.id,
    name: v.name,
    sku: v.sku,
    price: v.price,
    weight: v.weight,
    dimensions: v.dimensions,
    stockQuantity: v.stock_quantity ?? null,
    virtual: v.virtual,
    globalUniqueId: v.global_unique_id,
    imageSrc: imageSrc.parse(v.image),
    attributes: v.attributes,
    metaData: v.meta_data,
  }));

export type WooAddress = z.output<typeof addressSchema>;
export type WooMeta = z.output<typeof metaSchema>;
export type WooLineItem = z.output<typeof lineItemSchema>;
export type WooOrder = z.output<typeof orderSchema> & { raw: unknown };
export type WooProduct = z.output<typeof productSchema> & { raw: unknown };
export type WooVariation = z.output<typeof variationSchema> & { raw: unknown };

/** Parses with `schema`, keeping the original as `raw`. Throws `badResponse` naming the failing paths only. */
function parseWith<T>(schema: z.ZodType<T>, what: string) {
  return (value: unknown): T & { raw: unknown } => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join(".") || "(root)");
      throw new StoreError("badResponse", `${what}: ${[...new Set(paths)].join(", ")}`);
    }
    return { ...result.data, raw: value };
  };
}

export const parseOrder = parseWith(orderSchema, "order");
export const parseProduct = parseWith(productSchema, "product");
export const parseVariation = parseWith(variationSchema, "variation");
