import type {
  CustomsProduct,
  CustomsProductsInput,
  CustomsProductsPage,
  UpdateProductCustomsInput,
} from "@woolrus/contracts";
import type { Db, Prisma, Product } from "@woolrus/db";
import { recordAudit } from "../audit";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";

// The customs editor's data side (SPEC-shipping "Customs", FR-SHIP-13). The declaration itself
// (`buildCustoms`) comes with the rates and labels ticket. Store-sync's product upsert never writes
// these columns, so an edit here survives every sync.

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
async function internationalProductIds(db: Db): Promise<Set<string>> {
  const settings = await db.settings.findUnique({
    where: { id: 1 },
    select: { shipFromAddress: true },
  });
  const shipFrom = countryOf(settings?.shipFromAddress ?? null) ?? DEFAULT_SHIP_FROM_COUNTRY;
  const orders = await db.order.findMany({
    where: { status: { notIn: [...FINISHED] } },
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
  const international = await internationalProductIds(db);
  return toDto(product, international.has(productId));
}
