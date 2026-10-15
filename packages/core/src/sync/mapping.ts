import type { OrderAddress } from "@woolrus/contracts";
import type { Prisma } from "@woolrus/db";
import type {
  WooAddress,
  WooMeta,
  WooOrder,
  WooProduct,
  WooVariation,
} from "../adapters/woocommerce/adapter";
import { StoreError } from "../adapters/woocommerce/errors";
import { type DimensionUnit, toCents, toInches, toOunces, type WeightUnit } from "../units";

// WooCommerce objects (as parsed by the adapter's schemas) to the shapes Woolrus stores. Pure: ids
// stay WooCommerce ids, and the import resolves them to rows. See the spec's mapping table.

export type StoreUnits = { weight: WeightUnit; dimension: DimensionUnit };

/** Where the production store keeps bins is an open question (spec); until then, this meta key. */
export const BIN_LOCATION_META_KEY = "_bin_location";

export type ItemAttribute = { name: string; option: string };

export type MappedOrderItem = {
  wooLineItemId: number;
  /** null when the product was deleted in the store (`product_id: 0`). */
  wooProductId: number | null;
  wooVariationId: number | null;
  /** The bundle line this line belongs to (Product Bundles' `bundled_by`). */
  bundleParentWooLineItemId: number | null;
  name: string;
  sku: string | null;
  quantity: number;
  unitPriceCents: number;
  imageUrl: string | null;
  attributes: ItemAttribute[];
  metaData: WooMeta[];
};

export type MappedOrder = {
  wooOrderId: number;
  number: string;
  wooStatus: string;
  currency: string;
  customerName: string;
  customerEmail: string | null;
  shippingAddress: OrderAddress;
  billingAddress: OrderAddress;
  customerNote: string | null;
  paymentMethod: string | null;
  totalCents: number;
  shippingChargedCents: number;
  shippingMethod: string | null;
  orderedAt: Date;
  wooModifiedAt: Date;
  rawPayload: Prisma.InputJsonValue;
  items: MappedOrderItem[];
};

/** Catalog fields sync owns. `binLocation` and `barcode` are absent unless the store sends them. */
type MappedCatalogFields = {
  sku: string | null;
  imageUrl: string | null;
  priceCents: number | null;
  weightOz: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  stockQuantity: number | null;
  binLocation?: string;
  barcode?: string;
  rawPayload: Prisma.InputJsonValue;
};

export type MappedProduct = MappedCatalogFields & {
  wooProductId: number;
  type: string;
  name: string;
  physical: boolean;
};

export type MappedVariation = MappedCatalogFields & {
  wooVariationId: number;
  wooProductId: number;
  name: string;
  attributes: ItemAttribute[];
};

export function mapOrder(order: WooOrder): MappedOrder {
  const cents = (value: string | null, field: string) =>
    value === null ? 0 : decimalOr(`order ${order.id}: ${field}`, () => toCents(value));
  const shippingAddress = toAddress(order.shipping);
  const billingAddress = toAddress(order.billing);
  const methods = order.shippingLines.map((s) => s.methodTitle).filter((t) => t !== null);

  return {
    wooOrderId: order.id,
    number: order.number,
    wooStatus: order.status,
    currency: order.currency,
    customerName:
      shippingAddress.name ?? billingAddress.name ?? order.billing.email ?? `#${order.number}`,
    customerEmail: order.billing.email,
    shippingAddress,
    billingAddress,
    customerNote: order.customerNote,
    paymentMethod: order.paymentMethodTitle,
    totalCents: cents(order.total, "total"),
    shippingChargedCents: order.shippingLines.reduce(
      (sum, s, i) => sum + cents(s.total, `shipping_lines.${i}.total`),
      0,
    ),
    shippingMethod: methods.length > 0 ? methods.join(", ") : null,
    orderedAt: order.dateCreatedGmt,
    wooModifiedAt: order.dateModifiedGmt,
    rawPayload: order.raw as Prisma.InputJsonValue,
    items: order.lineItems.map((line, i) => ({
      wooLineItemId: line.id,
      wooProductId: line.productId || null,
      wooVariationId: line.variationId || null,
      bundleParentWooLineItemId: line.bundledBy,
      name: line.name,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: cents(line.price, `line_items.${i}.price`),
      imageUrl: line.imageSrc,
      attributes: lineAttributes(line.metaData),
      metaData: line.metaData,
    })),
  };
}

export function mapProduct(product: WooProduct, units: StoreUnits): MappedProduct {
  return {
    wooProductId: product.id,
    type: product.type,
    name: product.name,
    physical: !product.virtual,
    ...catalogFields(`product ${product.id}`, product, units),
  };
}

/** `productId` is the parent's WooCommerce id (variations are listed per product). */
export function mapVariation(
  productId: number,
  variation: WooVariation,
  units: StoreUnits,
): MappedVariation {
  const attributes = variation.attributes.map((a) => ({ name: a.name, option: a.option }));
  return {
    wooVariationId: variation.id,
    wooProductId: productId,
    name: variation.name ?? attributes.map((a) => a.option).join(" / "),
    attributes,
    ...catalogFields(`variation ${variation.id}`, variation, units),
  };
}

function catalogFields(
  what: string,
  item: WooProduct | WooVariation,
  units: StoreUnits,
): MappedCatalogFields {
  const { price, weight, dimensions } = item;
  const inches = (value: string | null, field: string) =>
    decimalOr(`${what}: dimensions.${field}`, () => toInches(value, units.dimension));
  const bin = item.metaData.find((m) => m.key === BIN_LOCATION_META_KEY)?.value;
  const binLocation = typeof bin === "string" ? bin.trim() : "";

  return {
    sku: item.sku,
    imageUrl: item.imageSrc,
    priceCents: price === null ? null : decimalOr(`${what}: price`, () => toCents(price)),
    weightOz: decimalOr(`${what}: weight`, () => toOunces(weight, units.weight)),
    lengthIn: inches(dimensions.length, "length"),
    widthIn: inches(dimensions.width, "width"),
    heightIn: inches(dimensions.height, "height"),
    stockQuantity: item.stockQuantity,
    ...(binLocation ? { binLocation } : {}),
    ...(item.globalUniqueId ? { barcode: item.globalUniqueId } : {}),
    rawPayload: item.raw as Prisma.InputJsonValue,
  };
}

/** The stored address shape (`OrderAddress`): one `name`, and only the fields that are set. */
function toAddress(a: WooAddress): OrderAddress {
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ");
  const fields: OrderAddress = {
    name: name || undefined,
    company: a.company ?? undefined,
    address1: a.address1 ?? undefined,
    address2: a.address2 ?? undefined,
    city: a.city ?? undefined,
    state: a.state ?? undefined,
    postalCode: a.postcode ?? undefined,
    country: a.country ?? undefined,
    phone: a.phone ?? undefined,
    email: a.email ?? undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** Public meta (no leading `_`) with a text or number value: variation options, custom fields. */
function lineAttributes(meta: WooMeta[]): ItemAttribute[] {
  return meta.flatMap((m) => {
    const value = m.displayValue;
    if (m.key.startsWith("_") || (typeof value !== "string" && typeof value !== "number"))
      return [];
    return [{ name: m.displayKey, option: String(value) }];
  });
}

/** Runs a decimal conversion; a malformed value fails the order as `badResponse`, naming the field only. */
function decimalOr<T>(field: string, convert: () => T): T {
  try {
    return convert();
  } catch {
    throw new StoreError("badResponse", `${field}: not a decimal number`);
  }
}
