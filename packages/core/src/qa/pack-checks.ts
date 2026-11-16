import type { AcknowledgeCheckInput, ConfirmBoxInput, QaResult } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { touchClaim } from "../workflow/claims";
import { notifyOrderChanged } from "../workflow/notify";
import { BOX_CHECKS } from "./box-confirm";
import { type QaOptions, qaResult } from "./queries";
import { lockForQa } from "./verify";

// QA acknowledges the packing check trips saved when the order left Packing, and confirms boxes
// (SPEC-packing A1 "QA side"). Like the other QA writes, these don't bump Order.version.

/** A trip QA hasn't acknowledged yet, by the saved row. */
const open = { acknowledgedAt: null } as const;

/**
 * Acknowledges one saved trip (`order.qa`, the order in QA under the actor's live claim). Sending
 * it again changes and audits nothing; there's no un-acknowledge.
 */
export async function acknowledgeCheck(
  db: Db,
  actor: Actor,
  { tripId }: AcknowledgeCheckInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  return db.$transaction(async (tx) => {
    const ref = await tx.packageCheckTrip.findUnique({
      where: { id: tripId },
      select: { package: { select: { orderId: true, discardedAt: true } } },
    });
    if (!ref || ref.package.discardedAt) throw notFound();
    const { orderId } = ref.package;
    const order = await lockForQa(tx, actor, orderId, now);

    const { count } = await tx.packageCheckTrip.updateMany({
      where: { id: tripId, ...open },
      data: { acknowledgedAt: now, acknowledgedById: actor.userId },
    });
    if (count > 0) {
      await recordAudit(tx, actor, {
        entityType: "PackageCheckTrip",
        entityId: tripId,
        action: "packCheckTrip.acknowledge",
        before: { acknowledged: false },
        after: { acknowledged: true },
        at: now,
      });
      await touchClaim(tx, actor, orderId, { now });
      await notifyOrderChanged(tx, { id: order.id, status: order.status });
    }
    return qaResult(tx, orderId, { now });
  });
}

/**
 * Confirms the package's physical box (same guard), and acknowledges its box-related trips in the
 * same transaction. Allowed when not required; again changes nothing. Weight trips need their own.
 */
export async function confirmBox(
  db: Db,
  actor: Actor,
  { packageId }: ConfirmBoxInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  return db.$transaction(async (tx) => {
    const ref = await tx.package.findUnique({
      where: { id: packageId },
      select: { orderId: true, discardedAt: true },
    });
    if (!ref || ref.discardedAt) throw notFound();
    const order = await lockForQa(tx, actor, ref.orderId, now);
    // Read after the lock, so a concurrent repack can't slip in between.
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: packageId },
      select: { boxConfirmedAt: true },
    });

    const trips = await tx.packageCheckTrip.findMany({
      where: { packageId, check: { in: [...BOX_CHECKS] }, ...open },
      select: { id: true, check: true },
    });
    if (pkg.boxConfirmedAt === null || trips.length > 0) {
      if (pkg.boxConfirmedAt === null) {
        await tx.package.update({
          where: { id: packageId },
          data: { boxConfirmedAt: now, boxConfirmedById: actor.userId },
        });
      }
      if (trips.length > 0) {
        await tx.packageCheckTrip.updateMany({
          where: { id: { in: trips.map((t) => t.id) } },
          data: { acknowledgedAt: now, acknowledgedById: actor.userId },
        });
      }
      await recordAudit(tx, actor, {
        entityType: "Package",
        entityId: packageId,
        action: "package.confirmBox",
        before: { boxConfirmed: pkg.boxConfirmedAt !== null },
        after: { boxConfirmed: true, acknowledged: trips.map((t) => t.check) },
        at: now,
      });
      await touchClaim(tx, actor, ref.orderId, { now });
      await notifyOrderChanged(tx, { id: order.id, status: order.status });
    }
    return qaResult(tx, ref.orderId, { now });
  });
}
