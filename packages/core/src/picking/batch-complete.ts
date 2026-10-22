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

/**
 * **Complete ready orders** / per-slot **Complete**: the single-order completion (`completePick`,
 * workflow's `completePicking` and its picked gate) for each order, each in its own transaction, and
 * a result per order. Orders that aren't live in the batch are reported, not moved.
 */
export async function completeBatchMembers(
  db: Db,
  actor: Parameters<typeof assertMayPick>[0],
  { id, orders }: CompletePickBatchInput,
  { now = new Date() }: BatchOptions = {},
): Promise<CompletePickBatchResult> {
  assertMayPick(actor);

  const live = await db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const row = await lockOwnBatch(tx, actor, id);
    if (row.closedAt) throw batchClosed();
    return new Set(
      row.orders
        .filter((m) => memberState(m, row.ownerId, expiry, now) === "live")
        .map((m) => m.orderId),
    );
  });

  const results: PickBatchCompletion[] = [];
  for (const { id: orderId, expectedVersion } of orders) {
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
      if (!(error instanceof AppError)) throw error;
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
    readBatch(tx, actor, id, await claimExpiryMinutes(tx), now),
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
    if (member.removedAt) return readBatch(tx, actor, id, expiry, now);
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
    return readBatch(tx, actor, id, expiry, now);
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
    return readBatch(tx, actor, id, expiry, now);
  });
}
