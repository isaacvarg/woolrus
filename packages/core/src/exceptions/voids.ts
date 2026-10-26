import {
  type ItemVoidView,
  type UndoVoidInput,
  VOID_REASON_MAX,
  type VoidItemInput,
  type VoidResult,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { reconcilePick } from "../picking/service";
import { claimExpiryMinutes, touchClaim } from "../workflow/claims";
import { liveLabelStatuses } from "../workflow/gates";
import { type LockedOrder, lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { displayName, nameFields } from "../workflow/people";
import { recomputePriorities } from "../workflow/priority-rules";
import { stageFor } from "./stage";

// Item voids (SPEC-exceptions "Void rules"). A void is a correction to the order, not stage work:
// no claim is needed and Order.version is not bumped (the status didn't change), so a void never
// makes someone else's screen stale. The order row lock serialises it with transitions, packing
// and other voids.

export type VoidOptions = { now?: Date };

export const voidInclude = {
  orderItem: { select: { name: true, sku: true } },
  voidedBy: { select: nameFields },
  undoneBy: { select: nameFields },
  resolvedBy: { select: nameFields },
} as const satisfies Prisma.ItemVoidInclude;

type VoidRow = Prisma.ItemVoidGetPayload<{ include: typeof voidInclude }>;

const person = (user: { name: string; email: string } | null) =>
  user ? { name: displayName(user) } : null;

export function toVoidView(row: VoidRow): ItemVoidView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    lineName: row.orderItem.name,
    sku: row.orderItem.sku,
    quantity: row.quantity,
    reason: row.reason,
    stage: row.stage,
    voidedBy: person(row.voidedBy),
    voidedAt: row.voidedAt,
    undoneAt: row.undoneAt,
    undoneBy: person(row.undoneBy),
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
    resolutionNotes: row.resolutionNotes,
    resolvedBy: person(row.resolvedBy),
  };
}

/** Quantity minus the line's voids that aren't undone, never below 0. */
async function activeQuantityOf(tx: DbTx, orderItemId: string): Promise<number> {
  const [item, voided] = await Promise.all([
    tx.orderItem.findUniqueOrThrow({ where: { id: orderItemId }, select: { quantity: true } }),
    tx.itemVoid.aggregate({ where: { orderItemId, undoneAt: null }, _sum: { quantity: true } }),
  ]);
  return Math.max(item.quantity - (voided._sum.quantity ?? 0), 0);
}

/** The order must be open and carry no label that exists or may exist at the carrier. */
async function assertVoidable(tx: DbTx, order: LockedOrder) {
  if (order.status === "COMPLETED" || order.status === "CANCELLED") {
    throw new AppError("CONFLICT", "errors.voids.orderClosed");
  }
  const labels = await tx.shippingLabel.count({
    where: { package: { orderId: order.id }, status: { in: [...liveLabelStatuses] } },
  });
  if (labels > 0) throw new AppError("CONFLICT", "errors.voids.liveLabels");
}

/** What a void or an undo ends with: the side effects other modules rely on, the record and the notify. */
async function finish(
  tx: DbTx,
  actor: Actor,
  order: LockedOrder,
  orderItemId: string,
  {
    action,
    voidId,
    before,
    after,
  }: {
    action: string;
    voidId: string;
    before: Prisma.InputJsonValue;
    after: Prisma.InputJsonValue;
  },
  now: Date,
): Promise<VoidResult> {
  await reconcilePick(tx, orderItemId);
  // A voided Rush Order line stops making the order Urgent, and an undo brings it back.
  await recomputePriorities(tx, { orderIds: [order.id], now });
  await recordAudit(tx, actor, {
    entityType: "ItemVoid",
    entityId: voidId,
    action,
    before,
    after,
    at: now,
  });
  await touchClaim(tx, actor, order.id, { now });
  await notifyOrderChanged(tx, { id: order.id, status: order.status });

  const [row, item, packed] = await Promise.all([
    tx.itemVoid.findUniqueOrThrow({ where: { id: voidId }, include: voidInclude }),
    tx.orderItem.findUniqueOrThrow({
      where: { id: orderItemId },
      select: { id: true, quantity: true, pickStatus: true },
    }),
    tx.packageItem.aggregate({ where: { orderItemId }, _sum: { quantity: true } }),
  ]);
  return {
    line: {
      id: item.id,
      quantity: item.quantity,
      activeQuantity: await activeQuantityOf(tx, orderItemId),
      pickStatus: item.pickStatus,
      packedQuantity: packed._sum.quantity ?? 0,
    },
    void: toVoidView(row),
  };
}

const invalid = (field: string, key: "errors.field.required" | "errors.field.tooBig") =>
  new AppError("BAD_REQUEST", "errors.validation", { [field]: key });

/** Voids `quantity` units of a line, with a reason (FR-VOID-01, 02, 06). */
export async function voidItem(
  db: Db,
  actor: Actor,
  { orderId, orderItemId, quantity, reason }: VoidItemInput,
  { now = new Date() }: VoidOptions = {},
): Promise<VoidResult> {
  assertCan(actor, "void.create");
  const text = reason.trim();
  if (!text) throw invalid("reason", "errors.field.required");
  if (text.length > VOID_REASON_MAX) throw invalid("reason", "errors.field.tooBig");

  return db.$transaction(async (tx) => {
    // Settings before the order lock: the lock order workflow uses everywhere.
    await claimExpiryMinutes(tx);
    const order = await lockOrder(tx, orderId);
    await assertVoidable(tx, order);
    // Read after the lock, so two voids of a line's last units can't both pass the check.
    const line = await tx.orderItem.findFirst({
      where: { id: orderItemId, orderId },
      select: { id: true },
    });
    if (!line) throw notFound();

    const active = await activeQuantityOf(tx, orderItemId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > active) {
      throw new AppError("CONFLICT", "errors.voids.quantity", undefined, { params: { active } });
    }
    const created = await tx.itemVoid.create({
      data: {
        orderId,
        orderItemId,
        quantity,
        reason: text,
        stage: stageFor(order),
        voidedById: actor.userId,
        voidedAt: now,
      },
    });
    return finish(
      tx,
      actor,
      order,
      orderItemId,
      {
        action: "void.create",
        voidId: created.id,
        before: { orderItemId, activeQuantity: active },
        after: { orderItemId, quantity, reason: text, activeQuantity: active - quantity },
      },
      now,
    );
  });
}

/** Undoes a void nobody has dealt with in the store yet (FR-VOID-03). */
export async function undoVoid(
  db: Db,
  actor: Actor,
  { voidId }: UndoVoidInput,
  { now = new Date() }: VoidOptions = {},
): Promise<VoidResult> {
  assertCan(actor, "void.create");
  return db.$transaction(async (tx) => {
    const ref = await tx.itemVoid.findUnique({
      where: { id: voidId },
      select: { orderId: true },
    });
    if (!ref) throw notFound();
    await claimExpiryMinutes(tx);
    const order = await lockOrder(tx, ref.orderId);
    // Read after the lock: a racing undo or resolve has finished by now.
    const current = await tx.itemVoid.findUnique({ where: { id: voidId } });
    if (!current) throw notFound();
    if (current.resolvedAt) throw new AppError("CONFLICT", "errors.voids.alreadyResolved");
    if (current.undoneAt) throw new AppError("CONFLICT", "errors.voids.alreadyUndone");
    await assertVoidable(tx, order);

    const active = await activeQuantityOf(tx, current.orderItemId);
    await tx.itemVoid.update({
      where: { id: voidId },
      data: { undoneAt: now, undoneById: actor.userId },
    });
    return finish(
      tx,
      actor,
      order,
      current.orderItemId,
      {
        action: "void.undo",
        voidId,
        before: { orderItemId: current.orderItemId, undoneAt: null, activeQuantity: active },
        after: {
          orderItemId: current.orderItemId,
          undoneAt: now.toISOString(),
          activeQuantity: active + current.quantity,
        },
      },
      now,
    );
  });
}
