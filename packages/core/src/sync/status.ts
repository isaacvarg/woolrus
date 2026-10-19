import type {
  ListSyncRunsInput,
  RunSyncInput,
  RunSyncResult,
  SyncRunErrorRow,
  SyncRunPage,
  SyncStatusView,
  TestConnectionResult,
} from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { StoreError } from "../adapters/woocommerce/errors";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { configuredStore } from "./schedule";

// The sync log, the nav's "last synced" and the admin's Sync now / Test connection
// (SPEC-store-sync "API", FR-SYNC-06/07/08). Responses carry counts, message keys and
// WooCommerce ids only: never secrets, never store payloads.

/** A poll that imported anything counts as success; PARTIAL only means some orders failed. */
const SUCCESSFUL = ["SUCCEEDED", "PARTIAL"] as const;

/** Stale after this many sync intervals without a successful poll (FR-SYNC-07). */
const LATE_AFTER_INTERVALS = 3;

/** Every signed-in user: the API's `authed` middleware is what requires the session. */
export async function getSyncStatus(
  db: Db,
  actor: Actor,
  { now = new Date() }: { now?: Date } = {},
): Promise<SyncStatusView> {
  assertCan(actor, "order.read");
  const [settings, lastPoll, lastFinished, lastSuccess, lastWebhook] = await Promise.all([
    loadSettings(db),
    db.syncRun.findFirst({ where: { type: "ORDERS_POLL" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({
      where: { type: "ORDERS_POLL", finishedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { status: true },
    }),
    db.syncRun.findFirst({
      where: { type: "ORDERS_POLL", status: { in: [...SUCCESSFUL] } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
    db.inboundWebhook.findFirst({
      where: { source: "woocommerce" },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    }),
  ]);

  const intervalMinutes = settings.syncIntervalMinutes;
  const lateBefore = now.getTime() - LATE_AFTER_INTERVALS * intervalMinutes * 60_000;
  const stale =
    lastFinished?.status === "FAILED"
      ? "failing"
      : !lastSuccess || lastSuccess.startedAt.getTime() < lateBefore
        ? "late"
        : null;

  return {
    lastPoll: lastPoll
      ? { startedAt: lastPoll.startedAt, finishedAt: lastPoll.finishedAt, status: lastPoll.status }
      : null,
    lastSuccessAt: lastSuccess?.startedAt ?? null,
    lastWebhookAt: lastWebhook?.receivedAt ?? null,
    intervalMinutes,
    stale,
  };
}

/** Where the previous page stopped: startedAt desc, id desc. */
type Cursor = { startedAt: Date; id: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = ({ startedAt, id }: Cursor) =>
  Buffer.from(JSON.stringify([startedAt.toISOString(), id])).toString("base64url");

function decodeCursor(cursor: string): Cursor {
  try {
    const [startedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const at = new Date(startedAt);
    if (!Number.isNaN(at.getTime()) && uuid.test(id)) return { startedAt: at, id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new AppError("BAD_REQUEST", "errors.validation", { cursor: "errors.field.invalid" });
}

/** `<message key>` or `<message key>: <detail>`, as `runs.ts` writes them. */
function splitError(error: string): { messageKey: string; detail: string | null } {
  const at = error.indexOf(": ");
  return at < 0
    ? { messageKey: error, detail: null }
    : { messageKey: error.slice(0, at), detail: error.slice(at + 2) };
}

/** The sync log, newest first (FR-SYNC-06). */
export async function listSyncRuns(
  db: Db,
  actor: Actor,
  { type, cursor, limit = 25 }: Partial<ListSyncRunsInput>,
): Promise<SyncRunPage> {
  assertCan(actor, "settings.manage");
  const after = cursor ? decodeCursor(cursor) : null;
  const rows = await db.syncRun.findMany({
    where: {
      ...(type ? { type } : {}),
      ...(after
        ? {
            OR: [
              { startedAt: { lt: after.startedAt } },
              { startedAt: after.startedAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((run) => {
      const error = run.error ? splitError(run.error) : null;
      return {
        id: run.id,
        type: run.type,
        status: run.status,
        processed: run.recordsProcessed,
        failed: run.recordsFailed,
        errorKey: error?.messageKey ?? null,
        errorDetail: error?.detail ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      };
    }),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/** A run's failed records, with the order each WooCommerce order id became, if it was imported. */
export async function listSyncRunErrors(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<SyncRunErrorRow[]> {
  assertCan(actor, "settings.manage");
  const run = await db.syncRun.findUnique({
    where: { id },
    select: { type: true, errors: { orderBy: { createdAt: "asc" } } },
  });
  if (!run) throw notFound();

  // Product runs record product ids, which aren't orders.
  const wooOrderIds =
    run.type === "PRODUCTS"
      ? []
      : run.errors.map((e) => Number(e.externalId)).filter((n) => Number.isSafeInteger(n));
  const orders = wooOrderIds.length
    ? await db.order.findMany({
        where: { wooOrderId: { in: wooOrderIds } },
        select: { id: true, number: true, wooOrderId: true },
      })
    : [];
  const orderByWooId = new Map(orders.map((o) => [String(o.wooOrderId), o]));

  return run.errors.map((e) => {
    const order = orderByWooId.get(e.externalId);
    return {
      id: e.id,
      externalId: e.externalId,
      ...splitError(e.error),
      order: order ? { id: order.id, number: order.number } : null,
      createdAt: e.createdAt,
    };
  });
}

const targetQueues = { orders: queues.ordersSync, products: queues.productsSync } as const;

/**
 * "Sync orders now" / "Sync products now": queues a manual job for the worker, which always runs
 * it (no interval check) and serialises it with every other run through the sync lock.
 */
export async function requestSync(
  db: Db,
  actor: Actor,
  { idempotencyKey, target }: RunSyncInput,
): Promise<RunSyncResult> {
  assertCan(actor, "settings.manage");
  return db.$transaction((tx) =>
    withIdempotency(tx, idempotencyKey, "sync.run", actor, async () => {
      const jobId = await enqueue(tx, targetQueues[target], { reason: "manual" });
      await recordAudit(tx, actor, {
        entityType: "Sync",
        entityId: target,
        action: "sync.request",
      });
      return { target, queued: jobId !== null };
    }),
  );
}

/**
 * Test connection waits on the store while the admin watches, so it gives up sooner than sync and
 * doesn't retry: an unreachable store answers in 10 s, not ~45 s of retries and backoff.
 */
const TEST_TIMEOUT_MS = 10_000;

/**
 * Checks the saved URL and keys against the store (Settings → Integrations → Test connection).
 * Failures are a result, not an error: the card shows the translated reason.
 */
export async function testStoreConnection(
  db: Db,
  actor: Actor,
  connect: (db: Db) => Promise<StoreAdapter | null> = (db) =>
    configuredStore(db, { timeoutMs: TEST_TIMEOUT_MS, retries: 0 }),
): Promise<TestConnectionResult> {
  assertCan(actor, "settings.manage");
  try {
    const store = await connect(db);
    if (!store) return { ok: false, messageKey: "errors.sync.notConfigured" };
    await store.ping();
    return { ok: true, units: await store.getUnits() };
  } catch (error) {
    // A saved secret that can't be decrypted is a settings problem worth showing here too.
    if (error instanceof StoreError || error instanceof AppError) {
      return { ok: false, messageKey: error.messageKey };
    }
    throw error;
  }
}
