import type { PushErrors, RetryWooPushInput, RetryWooPushResult } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";

// The Push errors view (SPEC-shipping "Push errors view", FR-SHIP-10): orders whose WooCommerce
// update failed, or has sat pending longer than the retry window, and the admin's Retry.

/** A push still pending after this long has lost its job or its retries; a person should look. */
const STALE_PENDING_MS = 15 * 60_000;

const inError = (now: Date) => ({
  status: "COMPLETED" as const,
  OR: [
    { wooPushStatus: "FAILED" as const },
    {
      wooPushStatus: "PENDING" as const,
      updatedAt: { lt: new Date(now.getTime() - STALE_PENDING_MS) },
    },
  ],
});

/** Orders to look at, oldest try first. `updatedAt` is the last time the push touched the order. */
export async function pushErrors(
  db: Db,
  actor: Actor,
  { now = new Date() }: { now?: Date } = {},
): Promise<PushErrors> {
  assertCan(actor, "settings.manage");
  const orders = await db.order.findMany({
    where: inError(now),
    select: {
      id: true,
      number: true,
      wooPushStatus: true,
      wooPushError: true,
      wooPushAttempts: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: 500,
  });
  return {
    rows: orders.map((o) => ({
      orderId: o.id,
      orderNumber: o.number,
      status: o.wooPushStatus === "FAILED" ? "FAILED" : "PENDING",
      error: o.wooPushError,
      attempts: o.wooPushAttempts,
      lastTryAt: o.updatedAt,
    })),
  };
}

/**
 * Sets the chosen orders `PENDING` and queues the job again. An order that isn't in error any
 * more (it succeeded meanwhile, or is still fresh) is left alone and not counted.
 */
export async function retryWooPush(
  db: Db,
  actor: Actor,
  { orderIds }: RetryWooPushInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<RetryWooPushResult> {
  assertCan(actor, "settings.manage");
  let retried = 0;
  for (const orderId of new Set(orderIds)) {
    const did = await db.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, ...inError(now) },
        data: { wooPushStatus: "PENDING", wooPushError: null },
      });
      if (count === 0) return false;
      await recordAudit(tx, actor, {
        entityType: "order",
        entityId: orderId,
        action: "woo.push.retry",
      });
      await enqueue(tx, queues.wooPush, { orderId }, { singletonKey: orderId });
      return true;
    });
    if (did) retried += 1;
  }
  return { retried };
}
