import type { QaResult, SetVerifiedInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { claimExpiryMinutes, holdsClaim, isClaimLive, touchClaim } from "../workflow/claims";
import { type LockedOrder, lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { type QaOptions, qaResult } from "./queries";

// Per-item verification (SPEC-qa "Verification"). Like pick and pack writes, these don't bump
// Order.version: only the claim holder writes, and the order lock orders them against transitions.

/** Locks the order and checks it is in QA under the actor's live claim. Run inside a transaction. */
export async function lockForQa(
  tx: DbTx,
  actor: Actor,
  orderId: string,
  now: Date,
): Promise<LockedOrder> {
  // Settings before the order lock: the lock order workflow uses everywhere.
  const expiry = await claimExpiryMinutes(tx);
  const order = await lockOrder(tx, orderId);
  if (order.status !== "QA") throw new AppError("CONFLICT", "errors.qa.notQa");
  if (!isClaimLive(order, expiry, now) || !holdsClaim(actor, order.claimedById)) {
    throw new AppError("CONFLICT", "errors.workflow.claimRequired");
  }
  return order;
}

const snapshot = (row: { qaVerifiedQuantity: number; quantity: number }) => ({
  verifiedQuantity: row.qaVerifiedQuantity,
  quantity: row.quantity,
});

/**
 * Tap: `true` verifies the row in full, `false` clears it. The same state again changes and
 * audits nothing, and a replayed key answers without looking at the order again.
 */
export async function setVerified(
  db: Db,
  actor: Actor,
  { packageItemId, verified, idempotencyKey }: SetVerifiedInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  return db.$transaction(async (tx) => {
    const ref = await tx.packageItem.findUnique({
      where: { id: packageItemId },
      select: { package: { select: { orderId: true } } },
    });
    if (!ref) throw notFound();
    const { orderId } = ref.package;

    const replay = await storedResult<{ orderId: string }>(
      tx,
      idempotencyKey,
      "qa.setVerified",
      actor,
    );
    if (replay) {
      if (replay.orderId !== orderId) throw new AppError("CONFLICT", "errors.conflict");
      return qaResult(tx, orderId);
    }

    const order = await lockForQa(tx, actor, orderId, now);
    // Read after the lock, so a concurrent repack can't slip in between.
    const row = await tx.packageItem.findUnique({ where: { id: packageItemId } });
    if (!row) throw notFound();
    if (
      (await tx.shippingLabel.count({ where: { package: { orderId }, status: "PURCHASING" } })) > 0
    ) {
      throw new AppError("CONFLICT", "errors.qa.purchaseInProgress");
    }

    await withIdempotency(tx, idempotencyKey, "qa.setVerified", actor, async () => {
      const target = verified ? row.quantity : 0;
      if (row.qaVerifiedQuantity !== target) {
        await tx.packageItem.update({
          where: { id: row.id },
          data: {
            qaVerifiedQuantity: target,
            qaVerifiedAt: verified ? now : null,
            qaVerifiedById: verified ? actor.userId : null,
          },
        });
        await recordAudit(tx, actor, {
          entityType: "PackageItem",
          entityId: row.id,
          action: verified ? "packageItem.verify" : "packageItem.unverify",
          before: snapshot(row),
          after: snapshot({ ...row, qaVerifiedQuantity: target }),
          at: now,
        });
        await touchClaim(tx, actor, orderId, { now });
        await notifyOrderChanged(tx, { id: order.id, status: order.status });
      }
      return { orderId };
    });
    return qaResult(tx, orderId);
  });
}
