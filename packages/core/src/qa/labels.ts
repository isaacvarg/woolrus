import type { MarkLabelNotBoughtInput, QaResult } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { JOBS_SCHEMA, queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { type QaOptions, qaResult } from "./queries";

// Settling labels whose purchase outcome is unknown, and the sweep for jobs that died
// (SPEC-qa "Settling and voiding" and "The labels.purchase job").

/** How long a label may stay PURCHASING before the sweep looks at its order again. */
export const STALE_PURCHASE_MINUTES = 10;

/**
 * Releases a purchase whose outcome nobody could confirm: the user has checked the provider and
 * found no label, so the package can be bought again. Only a `PURCHASING` label marked
 * `purchaseUnknown`; the reason is audited.
 */
export async function markLabelNotBought(
  db: Db,
  actor: Actor,
  { labelId, reason }: MarkLabelNotBoughtInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "label.void");
  return db.$transaction(async (tx) => {
    const found = await tx.shippingLabel.findUnique({
      where: { id: labelId },
      select: { package: { select: { orderId: true } } },
    });
    const orderId = found?.package?.orderId;
    if (!orderId) throw notFound();
    const order = await lockOrder(tx, orderId);

    // Read after the lock: the job may have settled it meanwhile.
    const label = await tx.shippingLabel.findUniqueOrThrow({ where: { id: labelId } });
    if (label.status !== "PURCHASING" || label.error !== "errors.qa.purchaseUnknown") {
      throw new AppError("CONFLICT", "errors.qa.labelNotUnknown");
    }
    await tx.shippingLabel.update({
      where: { id: labelId },
      data: { status: "PURCHASE_FAILED", error: "errors.qa.settledManually" },
    });
    await recordAudit(tx, actor, {
      entityType: "ShippingLabel",
      entityId: labelId,
      action: "label.markNotBought",
      before: { status: label.status, error: label.error },
      after: { status: "PURCHASE_FAILED", reason },
      at: now,
    });
    await notifyOrderChanged(tx, { id: orderId, status: order.status });
    return qaResult(tx, orderId, { now });
  });
}

/**
 * `labels.reconcile`: queues a `labels.purchase` job for every order with a label left PURCHASING
 * for over ten minutes (a worker died mid-purchase). Labels waiting for a person are skipped, and
 * the per-order singleton key stops a second job while one is queued. Returns the orders queued.
 */
export async function reconcileLabels(
  db: Db,
  { now = new Date() }: { now?: Date } = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PURCHASE_MINUTES * 60_000);
  const stale = await db.shippingLabel.findMany({
    where: {
      status: "PURCHASING",
      createdAt: { lt: cutoff },
      OR: [{ error: null }, { error: { not: "errors.qa.purchaseUnknown" } }],
      purchasedById: { not: null },
      package: { isNot: null },
    },
    select: { purchasedById: true, package: { select: { orderId: true } } },
    orderBy: { createdAt: "asc" },
  });
  const requesters = new Map<string, string>();
  for (const label of stale) {
    if (label.package && label.purchasedById) {
      requesters.set(label.package.orderId, label.purchasedById);
    }
  }
  // A queue's default policy doesn't dedupe by key, so look for a job still to run.
  const waiting = await db.$queryRawUnsafe<{ orderId: string }[]>(
    `SELECT data->>'orderId' AS "orderId" FROM ${JOBS_SCHEMA}.job
     WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
    queues.labelsPurchase,
  );
  const busy = new Set(waiting.map((j) => j.orderId));
  let queued = 0;
  for (const [orderId, requestedById] of requesters) {
    if (busy.has(orderId)) continue;
    await db.$transaction((tx) =>
      enqueue(tx, queues.labelsPurchase, { orderId, requestedById }, { singletonKey: orderId }),
    );
    queued++;
  }
  return queued;
}
