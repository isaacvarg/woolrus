import type { ScanBatchInput, ScanBatchResult } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { AppError, forbidden, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { type Actor, can, type UserActor } from "../permissions";
import { claimExpiryMinutes } from "../workflow/claims";
import { lockOrders } from "../workflow/lock";
import {
  assertMayPick,
  type BatchOptions,
  batchInclude,
  closeIfSpent,
  type MemberRow,
  memberState,
} from "./batches";
import { normalizeCode } from "./codes";
import { addUnit, alreadyPicked, matchingLines, needsUnit, notOnOrder } from "./scan";
import { lineInclude, writeLineIn } from "./service";

// Batch scan (SPEC-picking "Batch scan"): one scanned code is one unit on the first live member, by
// slot, with a matching line that still needs it. Same refusals as `scan`; a refused scan throws, so
// it changes and audits nothing.

/**
 * For acting on a batch: the owner's open batch with its members' orders locked (in id order, like
 * `createBatch`), and the members still live under those locks. Someone else's batch is forbidden.
 * Null when the batch is closed, including one this call just closed for having nothing live left:
 * the caller commits that close and then refuses with `batchClosed`.
 */
export async function lockBatchForOwner(
  tx: DbTx,
  actor: UserActor,
  batchId: string,
  now: Date,
): Promise<{ live: MemberRow[] } | null> {
  // Settings before the order locks: the lock order workflow uses everywhere.
  const expiry = await claimExpiryMinutes(tx);
  const found = await tx.pickBatch.findUnique({
    where: { id: batchId },
    select: { ownerId: true, orders: { where: { removedAt: null }, select: { orderId: true } } },
  });
  if (!found) throw notFound();
  if (found.ownerId !== actor.userId) throw forbidden();
  await lockOrders(
    tx,
    found.orders.map((o) => o.orderId),
  );
  // Read again under the locks, so membership can't change before the write.
  const row = await tx.pickBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: batchInclude,
  });
  if (await closeIfSpent(tx, actor, row, expiry, now)) return null;
  return { live: row.orders.filter((m) => memberState(m, row.ownerId, expiry, now) === "live") };
}

/** Adds one unit to the first slot whose order still needs the scanned product. Idempotent on `scanId`. */
export async function scanBatch(
  db: Db,
  actor: Actor,
  { batchId, code, scanId }: ScanBatchInput,
  { now = new Date() }: BatchOptions = {},
): Promise<ScanBatchResult> {
  assertMayPick(actor);
  const wanted = normalizeCode(code);
  const result = await db.$transaction(async (tx) => {
    // A retried scan that already counted answers as it did, even if the batch has closed since.
    const replay = await storedResult<ScanBatchResult>(tx, scanId, "pickBatches.scan", actor);
    if (replay) return replay;

    const locked = await lockBatchForOwner(tx, actor, batchId, now);
    if (!locked) return null;
    const { live } = locked;
    return withIdempotency(tx, scanId, "pickBatches.scan", actor, async () => {
      const rows = await tx.orderItem.findMany({
        where: { orderId: { in: live.map((m) => m.order.id) } },
        include: lineInclude,
      });
      // By slot (members come in slot order), then pick order within each order.
      const matching = live.flatMap((member) =>
        matchingLines(
          rows.filter((row) => row.orderId === member.order.id),
          wanted,
        ).map((row) => ({ member, row })),
      );
      if (matching.length === 0) {
        throw await notOnOrder(
          tx,
          wanted,
          can(actor, "product.manage"),
          "errors.picking.scanNotInBatch",
        );
      }
      const hit = matching.find(({ row }) => needsUnit(row));
      if (!hit) throw alreadyPicked(matching.map(({ row }) => row));
      await writeLineIn(tx, actor, hit.row.id, "scan", addUnit(actor), now);
      return {
        orderId: hit.member.order.id,
        slot: hit.member.slot,
        number: hit.member.order.number,
        itemId: hit.row.id,
      };
    });
  });
  // Refused only now, so a close for having nothing live left commits rather than rolling back.
  if (!result) throw new AppError("CONFLICT", "errors.picking.batchClosed");
  return result;
}
