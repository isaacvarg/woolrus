import type { Db, SyncStatus } from "@woolrus/db";
import type { StoreAdapter, WooProduct } from "../adapters/woocommerce/adapter";
import { withSyncLock } from "./lock";
import { type MappedVariation, mapProduct, mapVariation, type StoreUnits } from "./mapping";
import { upsertCatalog } from "./products-upsert";
import { finishRun, recordRunError, runErrorKey, startRun } from "./runs";

// The catalog sync (SPEC-store-sync "Products", FR-SYNC-12). Orders already bring the products they
// need, so this is for freshness (stock, bins, weights). It never deletes: a product gone from the
// store just stops being refreshed. Warehouse-only fields are never written (see upsertCatalog).

export type SyncProductsResult = {
  runId: string;
  status: SyncStatus;
  /** Products written, each with its variations. */
  processed: number;
  failed: number;
};

/** Under the `products` lock: a second run while one holds it writes nothing. */
export async function syncProducts(
  db: Db,
  store: StoreAdapter | null,
  { now = new Date() }: { now?: Date } = {},
): Promise<SyncProductsResult | { status: "alreadyRunning" }> {
  const locked = await withSyncLock(db, "products", () => runSync(db, store, now));
  return locked.acquired ? locked.result : { status: "alreadyRunning" };
}

async function runSync(db: Db, store: StoreAdapter | null, now: Date): Promise<SyncProductsResult> {
  const runId = await startRun(db, "PRODUCTS", now);
  const counts = { processed: 0, failed: 0 };
  const finish = async (status: SyncStatus, error?: unknown) => {
    await finishRun(db, runId, {
      status,
      ...counts,
      ...(error === undefined ? {} : { error: runErrorKey(error) }),
    });
    return { runId, status, ...counts };
  };

  if (!store) {
    await finishRun(db, runId, {
      status: "FAILED",
      ...counts,
      error: "errors.sync.notConfigured",
    });
    return { runId, status: "FAILED", ...counts };
  }

  try {
    const units = await store.getUnits();
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const result = await store.listProducts(page);
      totalPages = result.totalPages;
      for (const product of result.products) {
        try {
          await writeProduct(db, store, units, product, now);
          counts.processed += 1;
        } catch (error) {
          counts.failed += 1;
          await recordRunError(db, runId, product.id, error);
        }
      }
    }
  } catch (error) {
    return finish("FAILED", error);
  }
  return finish(counts.failed > 0 ? "PARTIAL" : "SUCCEEDED");
}

/** One product and its variations, fetched first and then written together. */
async function writeProduct(
  db: Db,
  store: StoreAdapter,
  units: StoreUnits,
  woo: WooProduct,
  now: Date,
): Promise<void> {
  const product = mapProduct(woo, units);
  const variations: MappedVariation[] =
    woo.type === "variable"
      ? (await store.listVariations(woo.id)).map((v) => mapVariation(woo.id, v, units))
      : [];
  await db.$transaction((tx) => upsertCatalog(tx, { products: [product], variations }, now));
}
