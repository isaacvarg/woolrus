import type { Db, DbTx, Prisma, SyncStatus } from "@woolrus/db";
import type { StoreAdapter, WooOrder } from "../adapters/woocommerce/adapter";
import { recordAudit } from "../audit";
import { systemActor } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import { recomputePriorities } from "../workflow/priority-rules";
import { type MappedOrder, mapOrder, type StoreUnits } from "./mapping";
import { type FetchedCatalog, fetchOrderCatalog, upsertCatalog } from "./products-upsert";
import { finishRun, recordRunError, runErrorKey, startRun } from "./runs";

// Order import (SPEC-store-sync "Import"). Each order commits or rolls back on its own (FR-SYNC-03),
// so one bad order never blocks the rest, and the run records which ones failed and why.

export type SyncOrdersOptions = { type: "ORDERS_POLL" | "ORDERS_WEBHOOK"; now?: Date };

export type SyncOrdersResult = {
  runId: string;
  status: SyncStatus;
  imported: number;
  skipped: number;
  failed: number;
};

/** First argument of the two-key advisory lock taken per WooCommerce order id. */
const ORDER_LOCK_NAMESPACE = 4_201_002;

/** `store` is null when WooCommerce isn't configured: the run is logged as failed. */
export async function syncOrders(
  db: Db,
  store: StoreAdapter | null,
  { type, now = new Date() }: SyncOrdersOptions,
): Promise<SyncOrdersResult> {
  const runId = await startRun(db, type, now);
  const counts = { imported: 0, skipped: 0, failed: 0 };
  const finish = async (status: SyncStatus, error?: unknown) => {
    await finishRun(db, runId, {
      status,
      processed: counts.imported + counts.skipped,
      failed: counts.failed,
      ...(error === undefined ? {} : { error: runErrorKey(error) }),
    });
    return { runId, status, ...counts };
  };

  if (!store) {
    await finishRun(db, runId, {
      status: "FAILED",
      processed: 0,
      failed: 0,
      error: "errors.sync.notConfigured",
    });
    return { runId, status: "FAILED", ...counts };
  }

  try {
    const units = await store.getUnits();
    for await (const order of processingOrders(store)) {
      try {
        counts[await importOrder(db, store, units, order, now)] += 1;
      } catch (error) {
        counts.failed += 1;
        await recordRunError(db, runId, order.id, error);
      }
    }
  } catch (error) {
    // Units or a page couldn't be fetched: the run didn't see every order, so it isn't a finished
    // poll (later runs must not start their window after it).
    return finish("FAILED", error);
  }
  return finish(counts.failed > 0 ? "PARTIAL" : "SUCCEEDED");
}

/** Every `processing` order, page by page. */
async function* processingOrders(store: StoreAdapter): AsyncGenerator<WooOrder> {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const result = await store.listOrders({ status: "processing", page });
    totalPages = result.totalPages;
    yield* result.orders;
  }
}

async function importOrder(
  db: Db,
  store: StoreAdapter,
  units: StoreUnits,
  woo: WooOrder,
  now: Date,
): Promise<"imported" | "skipped"> {
  const order = mapOrder(woo);
  // Only paid orders ready to fulfil come in; others wait until the store moves them to processing.
  if (order.wooStatus !== "processing") return "skipped";
  if (await isKnown(db, order.wooOrderId)) return "skipped";

  const catalog = await fetchOrderCatalog(db, store, units, order, now);
  return db.$transaction(async (tx) => {
    // A webhook and a poll may import the same order at once; the second waits here, then skips.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_LOCK_NAMESPACE}::int, ${order.wooOrderId}::int)`;
    if (await isKnown(tx, order.wooOrderId)) return "skipped";
    await createOrder(tx, order, catalog, now);
    return "imported";
  });
}

async function isKnown(db: Db | DbTx, wooOrderId: number): Promise<boolean> {
  return (await db.order.count({ where: { wooOrderId } })) > 0;
}

async function createOrder(
  tx: DbTx,
  { items, ...fields }: MappedOrder,
  catalog: FetchedCatalog,
  now: Date,
): Promise<void> {
  await upsertCatalog(tx, catalog, now);
  const productIds = await rowIds(
    tx.product.findMany({
      where: { wooProductId: { in: items.flatMap((i) => i.wooProductId ?? []) } },
      select: { id: true, wooProductId: true },
    }),
    (p) => p.wooProductId,
  );
  const variationIds = await rowIds(
    tx.productVariation.findMany({
      where: { wooVariationId: { in: items.flatMap((i) => i.wooVariationId ?? []) } },
      select: { id: true, wooVariationId: true },
    }),
    (v) => v.wooVariationId,
  );

  const order = await tx.order.create({
    data: { ...fields, status: "PENDING", statusChangedAt: now, syncedAt: now },
  });

  const lineIds = new Map<number, string>();
  for (const { wooProductId, wooVariationId, bundleParentWooLineItemId: _, ...line } of items) {
    const item = await tx.orderItem.create({
      data: {
        ...line,
        // Meta values are whatever JSON the store sent.
        metaData: line.metaData as Prisma.InputJsonValue,
        orderId: order.id,
        productId: wooProductId === null ? null : (productIds.get(wooProductId) ?? null),
        variationId: wooVariationId === null ? null : (variationIds.get(wooVariationId) ?? null),
      },
      select: { id: true },
    });
    lineIds.set(line.wooLineItemId, item.id);
  }
  // Bundle parents can come after their children in the list, so they're linked once all exist.
  for (const line of items) {
    const parentId = line.bundleParentWooLineItemId && lineIds.get(line.bundleParentWooLineItemId);
    if (!parentId) continue;
    await tx.orderItem.update({
      where: { id: lineIds.get(line.wooLineItemId) },
      data: { bundleParentId: parentId },
    });
  }

  // Import has no prior status, so it writes the first stage event itself rather than `transition`.
  await tx.orderStageEvent.create({
    data: { orderId: order.id, fromStatus: null, toStatus: "PENDING", reason: "imported", at: now },
  });
  await recordAudit(tx, systemActor, {
    entityType: "Order",
    entityId: order.id,
    action: "order.import",
    after: { wooOrderId: order.wooOrderId, number: order.number, status: order.status },
    at: now,
  });
  await recomputePriorities(tx, { orderIds: [order.id], now });
  await notifyOrderChanged(tx, { id: order.id, status: order.status });
}

async function rowIds<T extends { id: string }>(
  rows: Promise<T[]>,
  key: (row: T) => number,
): Promise<Map<number, string>> {
  return new Map((await rows).map((row) => [key(row), row.id]));
}
