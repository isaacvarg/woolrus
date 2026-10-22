import type {
  CompletePickBatchInput,
  CompletePickBatchResult,
  PickBatch,
  PickBatchCompletion,
  PickBatchOrderInput,
} from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, forbidden, notFound } from "../errors";
import type { UserActor } from "../permissions";
import { claimExpiryMinutes } from "../workflow/claims";
import {
  assertMayPick,
  type BatchOptions,
  type BatchRow,
  batchInclude,
  closeBatch,
  memberState,
  readBatch,
} from "./batches";
import { completePick } from "./complete";

// Completing, removing and finishing (SPEC-picking "Pick batches"). Only the batch's owner acts on it.
// Completing moves each order on its own, so one that fails its gate doesn't hold the others back;
// removing and finishing leave the orders in Picking with the picker's claim.

/** The batch, row-locked so a remove and a finish can't interleave. Only its owner may act on it. */
async function lockOwnBatch(tx: DbTx, actor: UserActor, id: string): Promise<BatchRow> {
  await tx.$queryRaw`SELECT id FROM pick_batches WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.pickBatch.findUnique({ where: { id }, include: batchInclude });
  if (!row) throw notFound();
  if (row.ownerId !== actor.userId) throw forbidden();
  return row;
}

const batchClosed = () => new AppError("CONFLICT", "errors.picking.batchClosed");

export type CompleteBatchOptions = BatchOptions & {
  /** Told about an order whose completion failed unexpectedly; the others still go ahead. */
  onError?: (orderId: string, error: unknown) => void;
};

/**
 * **Complete ready orders** / per-slot **Complete**: the single-order completion (`completePick`,
 * workflow's `completePicking` and its picked gate) for each order, each in its own transaction, and
 * a result per order. Orders that aren't live in the batch are reported, not moved, except members
 * already in Packing: a retried Complete reports what the first one moved.
 */
export async function completeBatchMembers(
  db: Db,
  actor: Parameters<typeof assertMayPick>[0],
  { id, orders }: CompletePickBatchInput,
  { now = new Date(), onError }: CompleteBatchOptions = {},
): Promise<CompletePickBatchResult> {
  assertMayPick(actor);

  const { live, moved } = await db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const row = await lockOwnBatch(tx, actor, id);
    if (row.closedAt) throw batchClosed();
    const ids = (keep: (m: BatchRow["orders"][number]) => boolean) =>
      new Set(row.orders.filter(keep).map((m) => m.orderId));
    return {
      live: ids((m) => memberState(m, row.ownerId, expiry, now) === "live"),
      moved: ids((m) => m.removedAt === null && m.order.status === "PACKING"),
    };
  });

  const results: PickBatchCompletion[] = [];
  for (const { id: orderId, expectedVersion } of orders) {
    if (moved.has(orderId)) {
      results.push({ orderId, moved: true });
      continue;
    }
    if (!live.has(orderId)) {
      results.push({
        orderId,
        moved: false,
        messageKey: "errors.picking.notInBatch",
        params: {},
        unmet: [],
      });
      continue;
    }
    try {
      await completePick(db, actor, { orderId, expectedVersion, after: "queue" }, { now });
      results.push({ orderId, moved: true });
    } catch (error) {
      // Earlier orders have committed, so even an unexpected failure is reported per order rather
      // than thrown: the picker still learns which ones moved.
      if (!(error instanceof AppError)) {
        onError?.(orderId, error);
        results.push({
          orderId,
          moved: false,
          messageKey: "errors.internal",
          params: {},
          unmet: [],
        });
        continue;
      }
      results.push({
        orderId,
        moved: false,
        messageKey: error.messageKey,
        params: error.params ?? {},
        unmet: [...(error.unmet ?? [])],
      });
    }
  }

  // Read last: it closes the batch if nothing in it is live any more.
  const batch = await db.$transaction(async (tx) =>
    readBatch(tx, id, await claimExpiryMinutes(tx), now),
  );
  return { results, batch };
}

/** **Remove**: drops one order from the batch. It stays in Picking, still claimed by the picker. */
export async function removeFromBatch(
  db: Db,
  actor: Parameters<typeof assertMayPick>[0],
  { id, orderId }: PickBatchOrderInput,
  { now = new Date() }: BatchOptions = {},
): Promise<PickBatch> {
  assertMayPick(actor);
  return db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const row = await lockOwnBatch(tx, actor, id);
    const member = row.orders.find((m) => m.orderId === orderId);
    if (!member) throw notFound();
    // Already out (a replay, or the batch closed): nothing to do.
    if (member.removedAt) return readBatch(tx, id, expiry, now);
    if (row.closedAt) throw batchClosed();

    await tx.pickBatchOrder.update({
      where: { batchId_orderId: { batchId: id, orderId } },
      data: { removedAt: now },
    });
    await recordAudit(tx, actor, {
      entityType: "PickBatch",
      entityId: id,
      action: "pickBatch.removeOrder",
      after: { orderId, slot: member.slot },
      at: now,
    });
    return readBatch(tx, id, expiry, now);
  });
}

/** **Finish batch**: closes it. Orders still in it stay in Picking with the picker, outside any batch. */
export async function finishBatch(
  db: Db,
  actor: Parameters<typeof assertMayPick>[0],
  { id }: { id: string },
  { now = new Date() }: BatchOptions = {},
): Promise<PickBatch> {
  assertMayPick(actor);
  return db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const row = await lockOwnBatch(tx, actor, id);
    if (!row.closedAt) await closeBatch(tx, actor, id, now, { action: "pickBatch.finish" });
    return readBatch(tx, id, expiry, now);
  });
}
