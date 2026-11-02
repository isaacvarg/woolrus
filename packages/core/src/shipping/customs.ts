import type {
  CustomsProduct,
  CustomsProductsInput,
  CustomsProductsPage,
  OrderCustoms,
  OrderCustomsInput,
  UpdateProductCustomsInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Order, Prisma, Product } from "@woolrus/db";
import type { CustomsDeclaration } from "../adapters/shipping/provider";
import { recordAudit } from "../audit";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { toNumber } from "../units";

// Customs (SPEC-shipping "Customs", FR-SHIP-13): the editor's data side and the declaration
// (`buildCustoms`). Store-sync's product upsert never writes these columns, so an edit here
// survives every sync.

const PAGE_SIZE = 50;
const DEFAULT_SHIP_FROM_COUNTRY = "US";
/** Orders past these statuses no longer ship, so their products aren't "on an order now". */
const FINISHED = ["COMPLETED", "CANCELLED"] as const;

const customsFields = ["hsCode", "countryOfOrigin", "customsDescription"] as const;

function toDto(product: Product, onInternational: boolean): CustomsProduct {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    hsCode: product.hsCode,
    countryOfOrigin: product.countryOfOrigin,
    customsDescription: product.customsDescription,
    missing: product.hsCode === null || product.countryOfOrigin === null,
    onInternationalOrder: onInternational,
  };
}

function countryOf(address: Prisma.JsonValue | null): string | null {
  if (typeof address !== "object" || address === null || Array.isArray(address)) return null;
  const country = address.country;
  return typeof country === "string" && country !== "" ? country.toUpperCase() : null;
}

/** Products on a line of an open order whose ship-to (else Woo shipping address) is abroad. */
async function internationalProductIds(db: Db, only?: string): Promise<Set<string>> {
  const settings = await db.settings.findUnique({
    where: { id: 1 },
    select: { shipFromAddress: true },
  });
  const shipFrom = countryOf(settings?.shipFromAddress ?? null) ?? DEFAULT_SHIP_FROM_COUNTRY;
  const orders = await db.order.findMany({
    where: {
      status: { notIn: [...FINISHED] },
      ...(only && { items: { some: { productId: only } } }),
    },
    select: { shipTo: true, shippingAddress: true, items: { select: { productId: true } } },
  });
  const ids = new Set<string>();
  for (const order of orders) {
    const country = countryOf(order.shipTo) ?? countryOf(order.shippingAddress);
    if (country === null || country === shipFrom) continue;
    for (const { productId } of order.items) if (productId) ids.add(productId);
  }
  return ids;
}

/** Physical products, by name, with the customs data they have; `product.manage`. */
export async function customsProducts(
  db: Db,
  actor: Actor,
  { filter, cursor }: CustomsProductsInput,
  { pageSize = PAGE_SIZE }: { pageSize?: number } = {},
): Promise<CustomsProductsPage> {
  assertCan(actor, "product.manage");
  const international = await internationalProductIds(db);
  const where: Prisma.ProductWhereInput = { physical: true };
  if (filter === "missing") where.OR = [{ hsCode: null }, { countryOfOrigin: null }];
  if (filter === "international") where.id = { in: [...international] };

  const rows = await db.product.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: pageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, pageSize);
  return {
    items: page.map((product) => toDto(product, international.has(product.id))),
    nextCursor: rows.length > pageSize ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Sets or clears customs fields; only fields present change. Audited as `Product` `customs`. */
export async function updateProductCustoms(
  db: Db,
  actor: Actor,
  { productId, ...patch }: UpdateProductCustomsInput,
): Promise<CustomsProduct> {
  assertCan(actor, "product.manage");
  const product = await db.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id: productId } });
    if (!before) throw notFound();
    const changed = customsFields.filter(
      (field) => patch[field] !== undefined && patch[field] !== before[field],
    );
    if (changed.length === 0) return before;
    const data = Object.fromEntries(changed.map((field) => [field, patch[field]]));
    const after = await tx.product.update({ where: { id: productId }, data });
    await recordAudit(tx, actor, {
      entityType: "Product",
      entityId: productId,
      action: "customs",
      before: Object.fromEntries(changed.map((field) => [field, before[field]])),
      after: Object.fromEntries(changed.map((field) => [field, after[field]])),
    });
    return after;
  });
  const international = await internationalProductIds(db, productId);
  return toDto(product, international.has(productId));
}

/** The product fields a declaration reads; a variation line carries its parent product's. */
export type CustomsLineProduct = Pick<
  Product,
  "id" | "name" | "physical" | "hsCode" | "countryOfOrigin" | "customsDescription"
> & { weightOz: Prisma.Decimal | number | null };

/** One package row: its order line's identity and price, the units in this package, and the product. */
export type CustomsLine = {
  sku: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  product: CustomsLineProduct | null;
};

export type CustomsResult =
  | { complete: true; customs: CustomsDeclaration }
  | { complete: false; missing: string[] };

/**
 * The declaration for an international package, one item per row; lines whose product isn't
 * physical are skipped. A row without an HS code or origin (or without a product) makes it
 * incomplete, naming each such product once.
 */
export function buildCustoms(lines: readonly CustomsLine[]): CustomsResult {
  const items: CustomsDeclaration["items"] = [];
  const missing = new Set<string>();
  for (const line of lines) {
    const { product } = line;
    if (product && !product.physical) continue;
    if (!product?.hsCode || !product.countryOfOrigin) {
      missing.add(product?.name ?? line.name);
      continue;
    }
    const unitWeight =
      typeof product.weightOz === "number" ? product.weightOz : toNumber(product.weightOz);
    items.push({
      sku: line.sku,
      description: product.customsDescription ?? product.name,
      quantity: line.quantity,
      valueCents: line.unitPriceCents * line.quantity,
      currency: "USD",
      hsCode: product.hsCode,
      countryOfOrigin: product.countryOfOrigin,
      ...(unitWeight !== null && { weightOz: unitWeight * line.quantity }),
    });
  }
  if (missing.size > 0) return { complete: false, missing: [...missing] };
  return {
    complete: true,
    customs: { contents: "merchandise", nonDelivery: "return_to_sender", items },
  };
}

/** The order's destination is abroad: its ship-to (else Woo shipping address) differs from the ship-from country. */
async function shipsAbroad(db: Db | DbTx, order: Pick<Order, "shipTo" | "shippingAddress">) {
  const settings = await db.settings.findUnique({
    where: { id: 1 },
    select: { shipFromAddress: true },
  });
  const shipFrom = countryOf(settings?.shipFromAddress ?? null) ?? DEFAULT_SHIP_FROM_COUNTRY;
  const country = countryOf(order.shipTo) ?? countryOf(order.shippingAddress);
  return country !== null && country !== shipFrom;
}

/**
 * The products missing customs data, by package number, for an international order's packages;
 * empty when the order ships domestically or every row is covered.
 */
export async function missingCustomsByPackage(
  db: Db | DbTx,
  orderId: string,
): Promise<Map<number, string[]>> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      shipTo: true,
      shippingAddress: true,
      packages: {
        select: {
          number: true,
          items: {
            select: {
              quantity: true,
              orderItem: {
                select: { sku: true, name: true, unitPriceCents: true, product: true },
              },
            },
          },
        },
      },
    },
  });
  const missing = new Map<number, string[]>();
  if (!order || !(await shipsAbroad(db, order))) return missing;
  for (const pkg of order.packages) {
    const result = buildCustoms(customsLines(pkg.items));
    if (!result.complete) missing.set(pkg.number, result.missing);
  }
  return missing;
}

/** The order's customs status for the packing, QA and order screens; `order.read`. */
export async function orderCustoms(
  db: Db,
  actor: Actor,
  { orderId }: OrderCustomsInput,
): Promise<OrderCustoms> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { shipTo: true, shippingAddress: true },
  });
  if (!order) throw notFound();
  if (!(await shipsAbroad(db, order))) return { international: false, missing: [] };
  const missing = await missingCustomsByPackage(db, orderId);
  return {
    international: true,
    missing: [...missing].map(([number, products]) => ({ package: number, products })),
  };
}

/** Package rows (with their order line and its product) as the declaration reads them. */
export function customsLines(
  items: readonly {
    quantity: number;
    orderItem: {
      sku: string | null;
      name: string;
      unitPriceCents: number;
      product: CustomsLineProduct | null;
    };
  }[],
): CustomsLine[] {
  return items.map(({ quantity, orderItem }) => ({
    sku: orderItem.sku,
    name: orderItem.name,
    quantity,
    unitPriceCents: orderItem.unitPriceCents,
    product: orderItem.product,
  }));
}
