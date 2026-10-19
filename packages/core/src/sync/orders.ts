import type { Db, DbTx, Prisma, SyncStatus } from "@woolrus/db";
import type { ListOrdersQuery, StoreAdapter, WooOrder } from "../adapters/woocommerce/adapter";
import { recordAudit } from "../audit";
import { systemActor } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import { recomputePriorities } from "../workflow/priority-rules";
import { withSyncLock } from "./lock";
import { type MappedOrder, mapOrder, type StoreUnits } from "./mapping";
import { type FetchedCatalog, fetchOrderCatalog, upsertCatalog } from "./products-upsert";
import { finishRun, recordRunError, runErrorKey, startRun } from "./runs";

// Order import (SPEC-store-sync "Import"). Each order commits or rolls back on its own (FR-SYNC-03),
// so one bad order never blocks the rest, and the run records which ones failed and why.

export type SyncOrdersOptions = {
  type: "ORDERS_POLL" | "ORDERS_WEBHOOK";
  /** Fetch just these orders (webhooks), instead of the poll's window. */
  orderIds?: number[];
  now?: Date;
};

export type SyncOrdersResult = {
  runId: string;
  status: SyncStatus;
  imported: number;
  /** Known orders whose informational fields (`wooStatus`, `wooModifiedAt`, payload) moved on. */
  updated: number;
  skipped: number;
  failed: number;
};

/** First argument of the two-key advisory lock taken per WooCommerce order id. */
const ORDER_LOCK_NAMESPACE = 4_201_002;

/** Each poll's window reaches this far before the last one started, for clock skew with the store. */
const POLL_OVERLAP_MS = 10 * 60 * 1000;

/**
 * Polls take the `orders` sync lock and return `alreadyRunning` (writing nothing) while another poll
 * holds it; single-order runs only take the per-order lock, so a webhook never waits behind a poll.
 * `store` is null when WooCommerce isn't configured: the run is logged as failed.
 */
export async function syncOrders(
  db: Db,
  store: StoreAdapter | null,
  options: SyncOrdersOptions,
): Promise<SyncOrdersResult | { status: "alreadyRunning" }> {
  if (options.orderIds) return runSync(db, store, options);
  const locked = await withSyncLock(db, "orders", () => runSync(db, store, options));
  return locked.acquired ? locked.result : { status: "alreadyRunning" };
}

async function runSync(
  db: Db,
  store: StoreAdapter | null,
  { type, orderIds, now = new Date() }: SyncOrdersOptions,
): Promise<SyncOrdersResult> {
  // Read before this run's row exists, so the window comes from the previous poll.
  const plan = orderIds ? ({ orderIds } as const) : await pollPlan(db);
  const runId = await startRun(db, type, now);
  const counts = { imported: 0, updated: 0, skipped: 0, failed: 0 };
  const finish = async (status: SyncStatus, error?: unknown) => {
    await finishRun(db, runId, {
      status,
      processed: counts.imported + counts.updated + counts.skipped,
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
    for await (const order of ordersToSync(store, plan)) {
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

type FetchPlan =
  | { orderIds: number[] }
  /** No poll has finished yet: every `processing` order. */
  | { first: true }
  | { modifiedAfter: Date; retryIds: number[] };

/**
 * Later polls take everything modified since the last finished poll started (any status, so
 * cancellations are seen), plus the ids that failed in it. A FAILED run doesn't count as finished:
 * it may have missed pages, so the next window still starts from the run before it.
 */
async function pollPlan(db: Db): Promise<FetchPlan> {
  const last = await db.syncRun.findFirst({
    where: { type: "ORDERS_POLL", status: { in: ["SUCCEEDED", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, errors: { select: { externalId: true } } },
  });
  if (!last) return { first: true };
  const retryIds = [...new Set(last.errors.map((e) => Number(e.externalId)))].filter(
    Number.isInteger,
  );
  return { modifiedAfter: new Date(last.startedAt.getTime() - POLL_OVERLAP_MS), retryIds };
}

async function* ordersToSync(store: StoreAdapter, plan: FetchPlan): AsyncGenerator<WooOrder> {
  if ("orderIds" in plan) {
    // Fetched from the store: a webhook body is never trusted as data. A missing order is skipped.
    for (const id of plan.orderIds) {
      const order = await store.getOrder(id);
      if (order) yield order;
    }
    return;
  }
  if ("first" in plan) {
    yield* pages(store, { status: "processing" });
    return;
  }
  const seen = new Set<number>();
  for await (const order of pages(store, { modifiedAfter: plan.modifiedAfter })) {
    seen.add(order.id);
    yield order;
  }
  const retry = plan.retryIds.filter((id) => !seen.has(id));
  if (retry.length > 0) yield* pages(store, { include: retry });
}

async function* pages(
  store: StoreAdapter,
  query: Omit<ListOrdersQuery, "page">,
): AsyncGenerator<WooOrder> {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const result = await store.listOrders({ ...query, page });
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
): Promise<"imported" | "updated" | "skipped"> {
  const order = mapOrder(woo);
  const known = await findKnown(db, order.wooOrderId);
  if (known) return isNewer(order, known) ? updateKnown(db, order) : "skipped";
  // Only paid orders ready to fulfil come in; others wait until the store moves them to processing.
  if (order.wooStatus !== "processing") return "skipped";

  const catalog = await fetchOrderCatalog(db, store, units, order, now);
  return db.$transaction(async (tx) => {
    // A webhook and a poll may import the same order at once; the second waits here, then skips.
    await lockWooOrder(tx, order.wooOrderId);
    if (await findKnown(tx, order.wooOrderId)) return "skipped";
    await createOrder(tx, order, catalog, now);
    return "imported";
  });
}

/**
 * A known order the store modified since. For now only the informational fields follow the store;
 * change detection (diff, auto-apply, hold, flag) builds on this in T8.
 */
async function updateKnown(db: Db, order: MappedOrder): Promise<"updated" | "skipped"> {
  return db.$transaction(async (tx) => {
    await lockWooOrder(tx, order.wooOrderId);
    const known = await findKnown(tx, order.wooOrderId);
    if (!known || !isNewer(order, known)) return "skipped";
    await tx.order.update({
      where: { wooOrderId: order.wooOrderId },
      data: {
        wooStatus: order.wooStatus,
        wooModifiedAt: order.wooModifiedAt,
        rawPayload: order.rawPayload,
        syncedAt: new Date(),
      },
    });
    return "updated";
  });
}

/** Idempotency (FR-SYNC-02): a store version we've already seen changes nothing. */
function isNewer(order: MappedOrder, known: { wooModifiedAt: Date }): boolean {
  return order.wooModifiedAt.getTime() > known.wooModifiedAt.getTime();
}

async function lockWooOrder(tx: DbTx, wooOrderId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_LOCK_NAMESPACE}::int, ${wooOrderId}::int)`;
}

function findKnown(db: Db | DbTx, wooOrderId: number) {
  return db.order.findUnique({ where: { wooOrderId }, select: { wooModifiedAt: true } });
}

async function createOrder(
  tx: DbTx,
  { items, refundedCents: _, ...fields }: MappedOrder,
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
  for (const { wooProductId, wooVariationId, bundleParentWooLineItemId: __, ...line } of items) {
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
