import { isDeepStrictEqual } from "node:util";
import type { Db, DbTx, Prisma, SyncStatus } from "@woolrus/db";
import type { ListOrdersQuery, StoreAdapter, WooOrder } from "../adapters/woocommerce/adapter";
import { recordAudit } from "../audit";
import { systemActor } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import { recomputePriorities } from "../workflow/priority-rules";
import { reconcileKnownOrder } from "./apply";
import { createLines } from "./lines";
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

/** Stage-event reason for an import: a message key, translated where history is shown. */
const IMPORTED_REASON = "sync.reason.imported";

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
    for await (const fetched of ordersToSync(store, plan)) {
      try {
        counts[await importOrder(db, store, units, fetched, now)] += 1;
      } catch (error) {
        counts.failed += 1;
        await recordRunError(db, runId, fetched.woo.id, error);
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

/**
 * A store copy of an order and when it was asked for. Woo's modified time has one-second
 * resolution, so for two copies from the same second the fetch time says which is newer.
 */
type Fetched = { woo: WooOrder; fetchedAt: Date };

async function* ordersToSync(store: StoreAdapter, plan: FetchPlan): AsyncGenerator<Fetched> {
  if ("orderIds" in plan) {
    // Fetched from the store: a webhook body is never trusted as data. A missing order is skipped.
    for (const id of plan.orderIds) {
      const fetchedAt = new Date();
      const woo = await store.getOrder(id);
      if (woo) yield { woo, fetchedAt };
    }
    return;
  }
  if ("first" in plan) {
    yield* pages(store, { status: "processing" });
    return;
  }
  const seen = new Set<number>();
  for await (const fetched of pages(store, { modifiedAfter: plan.modifiedAfter })) {
    seen.add(fetched.woo.id);
    yield fetched;
  }
  const retry = plan.retryIds.filter((id) => !seen.has(id));
  if (retry.length > 0) yield* pages(store, { include: retry });
}

async function* pages(
  store: StoreAdapter,
  query: Omit<ListOrdersQuery, "page">,
): AsyncGenerator<Fetched> {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const fetchedAt = new Date();
    const result = await store.listOrders({ ...query, page });
    totalPages = result.totalPages;
    for (const woo of result.orders) yield { woo, fetchedAt };
  }
}

/**
 * Creates the order, or runs change detection on it (FR-SYNC-10). Decided again under the
 * WooCommerce order's lock: a webhook and a poll can fetch the same order at once, and whichever
 * commits second must still land if its copy is the newer one.
 */
async function importOrder(
  db: Db,
  store: StoreAdapter,
  units: StoreUnits,
  { woo, fetchedAt }: Fetched,
  now: Date,
): Promise<"imported" | "updated" | "skipped"> {
  const order = mapOrder(woo);
  const known = await findKnown(db, order.wooOrderId);
  // Only paid orders ready to fulfil come in; others wait until the store moves them to processing.
  if (known ? !isNewVersion(order, fetchedAt, known) : order.wooStatus !== "processing") {
    return "skipped";
  }

  // The order's products (an edit's added lines too), so the transaction needs no HTTP.
  const catalog = await fetchOrderCatalog(db, store, units, order, now);
  return db.$transaction(async (tx) => {
    await lockWooOrder(tx, order.wooOrderId);
    const current = await findKnown(tx, order.wooOrderId);
    if (!current) {
      await createOrder(tx, order, catalog, now, fetchedAt);
      return "imported";
    }
    if (!isNewVersion(order, fetchedAt, current)) return "skipped";
    await upsertCatalog(tx, catalog, now);
    await reconcileKnownOrder(tx, current.id, order, now, fetchedAt);
    return "updated";
  });
}

/**
 * Idempotency (FR-SYNC-02): a store version we've already seen changes nothing. Woo's modified time
 * has one-second resolution, so an equal time is a new version only if the copy differs and was
 * fetched after the one stored (`syncedAt`): two copies from that second can arrive out of order.
 */
function isNewVersion(
  order: MappedOrder,
  fetchedAt: Date,
  known: { wooModifiedAt: Date; rawPayload: Prisma.JsonValue; syncedAt: Date },
): boolean {
  const incoming = order.wooModifiedAt.getTime();
  const stored = known.wooModifiedAt.getTime();
  if (incoming !== stored) return incoming > stored;
  return (
    fetchedAt.getTime() > known.syncedAt.getTime() &&
    !isDeepStrictEqual(order.rawPayload, known.rawPayload)
  );
}

async function lockWooOrder(tx: DbTx, wooOrderId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_LOCK_NAMESPACE}::int, ${wooOrderId}::int)`;
}

function findKnown(db: Db | DbTx, wooOrderId: number) {
  return db.order.findUnique({
    where: { wooOrderId },
    select: { id: true, wooModifiedAt: true, rawPayload: true, syncedAt: true },
  });
}

async function createOrder(
  tx: DbTx,
  { items, refundedCents: _, ...fields }: MappedOrder,
  catalog: FetchedCatalog,
  now: Date,
  fetchedAt: Date,
): Promise<void> {
  await upsertCatalog(tx, catalog, now);
  const order = await tx.order.create({
    data: { ...fields, status: "PENDING", statusChangedAt: now, syncedAt: fetchedAt },
  });
  await createLines(tx, order.id, items);

  // Import has no prior status, so it writes the first stage event itself rather than `transition`.
  await tx.orderStageEvent.create({
    data: {
      orderId: order.id,
      fromStatus: null,
      toStatus: "PENDING",
      reason: IMPORTED_REASON,
      at: now,
    },
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
