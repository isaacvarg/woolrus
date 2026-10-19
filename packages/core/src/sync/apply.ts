import { type DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { systemActor } from "../permissions";
import { toCents } from "../units";
import { claimExpiryMinutes } from "../workflow/claims";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { recomputePriorities } from "../workflow/priority-rules";
import { transition } from "../workflow/service";
import {
  type ChangeSummary,
  type DiffableOrder,
  diffOrder,
  hasChanges,
  isUntouched,
} from "./changes";
import { createLines } from "./lines";
import type { MappedOrder } from "./mapping";

// What the import does when the store changed an order it already has (SPEC-store-sync "Change
// detection" table, FR-SYNC-10). Nobody started on it: follow the store (cancel, or apply edits).
// Someone did: never change their order under them; hold it if the store cancelled, and flag it
// for an admin's Apply / Dismiss (review.ts).

/** The mapped store order kept for review. Its raw payload is already on the order row. */
export type IncomingOrder = Omit<MappedOrder, "rawPayload">;

/**
 * Stored in `externalChangeSummary` while flagged. `baseline` is the store status and refunded
 * total Woolrus last acted on: `wooStatus` and the payload follow the store on every sync, so a
 * later change must be diffed against this, or a store cancellation would drop out of the diff.
 */
export type ExternalChangeSummary = {
  diff: ChangeSummary;
  incoming: IncomingOrder;
  baseline: Baseline;
};
type Baseline = { wooStatus: string; refundedCents: number };

/**
 * Stored in `externalChangeSummary` after an admin's Dismiss (the flag itself cleared): the store
 * version they saw and kept out. Later store edits flag again only if they change a tracked field
 * relative to it, so plugin noise (export flags, invoice numbers) doesn't bring the flag back.
 */
export type DismissedSummary = { dismissed: IncomingOrder };

export type ChangeOutcome = "unchanged" | "cleared" | "cancelled" | "applied" | "held" | "flagged";

/** Store statuses that mean "don't ship this". */
const cancelledInStore: ReadonlySet<string> = new Set(["cancelled", "refunded", "failed"]);

/** Reason on the cancel / hold stage events and the hold: a message key, translated for display. */
export const CANCELLED_IN_STORE_REASON = "sync.reason.cancelledInStore";

/**
 * Call under the WooCommerce order's advisory lock, with the products of `incoming` written.
 * `fetchedAt` (when the store copy was asked for) becomes `syncedAt`, which orders same-second copies.
 */
export async function reconcileKnownOrder(
  tx: DbTx,
  orderId: string,
  incoming: MappedOrder,
  now: Date,
  fetchedAt: Date,
): Promise<ChangeOutcome> {
  // Settings before the order lock, as the workflow does, so the two can't deadlock.
  const expiryMinutes = await claimExpiryMinutes(tx);
  await lockOrder(tx, orderId);
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: {
        select: {
          wooLineItemId: true,
          name: true,
          sku: true,
          quantity: true,
          pickedQuantity: true,
        },
      },
      _count: { select: { packages: true, voids: true, qualityIssues: true, notes: true } },
    },
  });

  const flagged = order.externalChangeDetectedAt !== null;
  const baseline: Baseline = (flagged && baselineOf(order.externalChangeSummary)) || {
    wooStatus: order.wooStatus,
    refundedCents: refundedCentsOf(order.rawPayload),
  };
  const stored: DiffableOrder = {
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    shippingAddress: order.shippingAddress as DiffableOrder["shippingAddress"],
    billingAddress: order.billingAddress as DiffableOrder["billingAddress"],
    customerNote: order.customerNote,
    shippingMethod: order.shippingMethod,
    items: order.items,
    ...baseline,
  };
  const diff = withoutOwnEnd(diffOrder(stored, incoming), order.status);
  const dismissed = flagged ? null : dismissedOf(order.externalChangeSummary);
  // Informational: always the store's latest.
  const fromStore = {
    wooStatus: incoming.wooStatus,
    wooModifiedAt: incoming.wooModifiedAt,
    rawPayload: incoming.rawPayload,
    syncedAt: fetchedAt,
  };
  const clearFlag = { externalChangeDetectedAt: null, externalChangeSummary: Prisma.DbNull };

  // Nothing new since the admin dismissed it: follow the store informationally, keep the memory.
  if (dismissed && !hasChanges(diffOrder(dismissed, incoming))) {
    await tx.order.update({ where: { id: orderId }, data: fromStore });
    return "unchanged";
  }

  if (!hasChanges(diff)) {
    if (!flagged) {
      await tx.order.update({ where: { id: orderId }, data: fromStore });
      return "unchanged";
    }
    // The store went back to what Woolrus has: nothing left to review.
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { ...fromStore, ...clearFlag, version: { increment: 1 } },
    });
    await audit(tx, orderId, "order.externalChange.cleared", undefined, now);
    await notifyOrderChanged(tx, { id: orderId, status: updated.status });
    return "cleared";
  }

  const terminal = order.status === "COMPLETED" || order.status === "CANCELLED";
  const cancelled = diff.status !== undefined && cancelledInStore.has(diff.status.to);
  const untouched =
    !terminal &&
    isUntouched(
      {
        ...order,
        packages: order._count.packages,
        voids: order._count.voids,
        qualityIssues: order._count.qualityIssues,
        notes: order._count.notes,
      },
      expiryMinutes,
      now,
    );

  if (untouched && cancelled) {
    await tx.order.update({ where: { id: orderId }, data: { ...fromStore, ...clearFlag } });
    await transition(
      tx,
      systemActor,
      {
        orderId,
        expectedVersion: order.version,
        to: "CANCELLED",
        kind: "cancel",
        reason: CANCELLED_IN_STORE_REASON,
      },
      { now },
    );
    return "cancelled";
  }

  // Any other status change, or a refund, needs a person even on an untouched order.
  if (untouched && !diff.status && !diff.refunds) {
    await applyInPlace(tx, orderId, incoming, diff, { ...fromStore, ...clearFlag }, now);
    return "applied";
  }

  const hold = !terminal && cancelled && order.status !== "ON_HOLD";
  if (hold) {
    await transition(
      tx,
      systemActor,
      {
        orderId,
        expectedVersion: order.version,
        to: "ON_HOLD",
        kind: "hold",
        reason: CANCELLED_IN_STORE_REASON,
      },
      { now },
    );
  }
  const { rawPayload: _, ...kept } = incoming;
  const summary: ExternalChangeSummary = { diff, incoming: kept, baseline };
  const updated = await tx.order.update({
    where: { id: orderId },
    data: {
      ...fromStore,
      externalChangeDetectedAt: now,
      externalChangeSummary: summary as unknown as Prisma.InputJsonValue,
      // The floor's open screens go stale, so they reload and show the banner.
      version: { increment: 1 },
    },
  });
  await audit(tx, orderId, "order.externalChange.flagged", diff, now);
  await notifyOrderChanged(tx, { id: orderId, status: updated.status });
  return hold ? "held" : "flagged";
}

/** An untouched order takes the store's edit as it is: header fields, then lines. */
async function applyInPlace(
  tx: DbTx,
  orderId: string,
  incoming: MappedOrder,
  diff: ChangeSummary,
  fromStore: Prisma.OrderUpdateInput,
  now: Date,
): Promise<void> {
  const updated = await tx.order.update({
    where: { id: orderId },
    data: { ...fromStore, ...headerFields(incoming), version: { increment: 1 } },
  });
  // Untouched means nothing hangs off these lines (no picks, packages, voids, notes, issues).
  await writeLineChanges(tx, orderId, incoming, diff.lines);

  await audit(tx, orderId, "order.externalChange.applied", diff, now);
  await recomputePriorities(tx, { orderIds: [orderId], now });
  await notifyOrderChanged(tx, { id: orderId, status: updated.status });
}

/** The order fields a store edit replaces outright: who, where, the note and the money. */
export function headerFields(incoming: IncomingOrder) {
  return {
    customerName: incoming.customerName,
    customerEmail: incoming.customerEmail,
    shippingAddress: incoming.shippingAddress,
    billingAddress: incoming.billingAddress,
    customerNote: incoming.customerNote,
    paymentMethod: incoming.paymentMethod,
    shippingMethod: incoming.shippingMethod,
    totalCents: incoming.totalCents,
    shippingChargedCents: incoming.shippingChargedCents,
  } satisfies Prisma.OrderUpdateInput;
}

/** Removes, re-quantifies and adds lines as `lines` says. The caller has checked they can take it. */
export async function writeLineChanges(
  tx: DbTx,
  orderId: string,
  incoming: IncomingOrder,
  lines: ChangeSummary["lines"],
): Promise<void> {
  const removed = lines.removed.map((line) => line.wooLineItemId);
  if (removed.length > 0) {
    await tx.orderItem.deleteMany({ where: { orderId, wooLineItemId: { in: removed } } });
  }
  for (const { wooLineItemId, to } of lines.quantity) {
    await tx.orderItem.update({ where: { wooLineItemId }, data: { quantity: to } });
  }
  const added = new Set(lines.added.map((line) => line.wooLineItemId));
  await createLines(
    tx,
    orderId,
    incoming.items.filter((item) => added.has(item.wooLineItemId)),
  );
}

async function audit(
  tx: DbTx,
  orderId: string,
  action: string,
  diff: ChangeSummary | undefined,
  at: Date,
): Promise<void> {
  await recordAudit(tx, systemActor, {
    entityType: "Order",
    entityId: orderId,
    action,
    ...(diff ? { after: diff as unknown as Prisma.InputJsonValue } : {}),
    at,
  });
}

/**
 * Drops what is only the store catching up with Woolrus's own end state: Completed pushed by
 * `shipping`, or a cancelled order refunded by `exceptions`. Anything else still needs a person.
 */
function withoutOwnEnd(diff: ChangeSummary, status: string): ChangeSummary {
  if (status === "COMPLETED" && diff.status?.to === "completed") {
    const { status: _, ...rest } = diff;
    return rest;
  }
  if (status === "CANCELLED") {
    const { status: to, refunds: _, ...rest } = diff;
    return to && !cancelledInStore.has(to.to) ? { ...rest, status: to } : rest;
  }
  return diff;
}

/** The store version an admin dismissed, as a diff baseline (its refunds from the stored total). */
function dismissedOf(summary: Prisma.JsonValue): DiffableOrder | null {
  const dismissed = (summary as Partial<DismissedSummary> | null)?.dismissed;
  return dismissed ? { ...dismissed, refundedCents: dismissed.refundedCents ?? 0 } : null;
}

function baselineOf(summary: Prisma.JsonValue): Baseline | null {
  return (summary as ExternalChangeSummary | null)?.baseline ?? null;
}

/** The refunded total in a stored WooCommerce payload (refund totals are negative there). */
function refundedCentsOf(raw: Prisma.JsonValue): number {
  const refunds = (raw as { refunds?: unknown } | null)?.refunds;
  if (!Array.isArray(refunds)) return 0;
  return refunds.reduce<number>(
    (sum, refund) => sum + Math.abs(toCents(String((refund as { total?: unknown }).total ?? "0"))),
    0,
  );
}
