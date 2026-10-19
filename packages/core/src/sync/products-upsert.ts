import type { Db, DbTx } from "@woolrus/db";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import {
  type MappedOrder,
  type MappedProduct,
  type MappedVariation,
  mapProduct,
  mapVariation,
  type StoreUnits,
} from "./mapping";

// Products an order references (FR-SYNC-05). They're fetched before the order's transaction, so no
// transaction stays open across HTTP, and written inside it, so a failed order leaves no rows.

/** A product or variation synced more recently than this isn't fetched again for an order. */
export const PRODUCT_STALE_MS = 24 * 60 * 60 * 1000;

export type FetchedCatalog = { products: MappedProduct[]; variations: MappedVariation[] };

/** The order's products and variations that are missing or stale, fetched from the store. */
export async function fetchOrderCatalog(
  db: Db,
  store: StoreAdapter,
  units: StoreUnits,
  order: MappedOrder,
  now: Date,
): Promise<FetchedCatalog> {
  const freshSince = new Date(now.getTime() - PRODUCT_STALE_MS);
  const productIds = unique(order.items.map((i) => i.wooProductId));
  const variationIds = unique(order.items.map((i) => i.wooVariationId));

  const [freshProducts, freshVariations] = await Promise.all([
    db.product.findMany({
      where: { wooProductId: { in: productIds }, syncedAt: { gte: freshSince } },
      select: { wooProductId: true },
    }),
    db.productVariation.findMany({
      where: { wooVariationId: { in: variationIds }, syncedAt: { gte: freshSince } },
      select: { wooVariationId: true },
    }),
  ]);
  const freshProduct = new Set(freshProducts.map((p) => p.wooProductId));
  const freshVariation = new Set(freshVariations.map((v) => v.wooVariationId));

  // A stale variation is refreshed with its parent: variations are listed per product.
  const parentsOfStale = unique(
    order.items
      .filter((i) => i.wooVariationId !== null && !freshVariation.has(i.wooVariationId))
      .map((i) => i.wooProductId),
  );
  const toFetch = unique([...productIds.filter((id) => !freshProduct.has(id)), ...parentsOfStale]);
  if (toFetch.length === 0) return { products: [], variations: [] };

  // Ids the store no longer has are just missing: those lines keep whatever row they had, or none.
  const products = (await store.getProducts(toFetch)).map((p) => mapProduct(p, units));
  const variations: MappedVariation[] = [];
  for (const parent of products.filter((p) => parentsOfStale.includes(p.wooProductId))) {
    for (const v of await store.listVariations(parent.wooProductId)) {
      variations.push(mapVariation(parent.wooProductId, v, units));
    }
  }
  return { products, variations };
}

/**
 * Writes fetched products and variations, keyed on their WooCommerce ids. Only fields sync owns are
 * written, so customs, Lumexia and (unless the store sends one) barcode stay as the warehouse set them.
 */
export async function upsertCatalog(tx: DbTx, catalog: FetchedCatalog, now: Date): Promise<void> {
  // In id order: imports run concurrently (webhook jobs, a poll), and two orders sharing products
  // in opposite line order would otherwise lock their rows in opposite order and deadlock.
  const products = [...catalog.products].sort((a, b) => a.wooProductId - b.wooProductId);
  const variations = [...catalog.variations].sort((a, b) => a.wooVariationId - b.wooVariationId);
  const productRowIds = new Map<number, string>();
  for (const product of products) {
    const data = { ...product, syncedAt: now };
    const row = await tx.product.upsert({
      where: { wooProductId: product.wooProductId },
      create: data,
      update: data,
      select: { id: true },
    });
    productRowIds.set(product.wooProductId, row.id);
  }
  for (const { wooProductId, ...variation } of variations) {
    const productId = productRowIds.get(wooProductId);
    if (!productId) continue;
    const data = { ...variation, productId, syncedAt: now };
    await tx.productVariation.upsert({
      where: { wooVariationId: variation.wooVariationId },
      create: data,
      update: data,
    });
  }
}

function unique(ids: (number | null)[]): number[] {
  return [...new Set(ids.filter((id): id is number => id !== null))];
}
