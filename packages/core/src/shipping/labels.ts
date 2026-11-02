import type {
  LabelVoidStep,
  RetryVoidInput,
  StuckLabels,
  WriteOffLabelInput,
} from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan, can } from "../permissions";
import { type VoidLabelOptions, voidLabelStep } from "../qa/labels";
import type { QaOptions } from "../qa/queries";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";

// Labels stuck in Ready because their void was rejected or never answered (SPEC-shipping
// "Repack (write-off)", SRS §7.1 #6). Retry asks the provider again; an admin who has checked
// with the carrier writes the label off, which releases the repack. Rows are never deleted.

const stuckStatuses = ["VOID_REJECTED", "VOID_REQUESTED"] as const;

/** Repeats the void of one stuck label; the provider's answer is the new status. */
export async function retryVoid(
  db: Db,
  actor: Actor,
  { labelId }: RetryVoidInput,
  options: VoidLabelOptions = {},
): Promise<LabelVoidStep> {
  assertCan(actor, "order.repack");
  const label = await db.shippingLabel.findUnique({
    where: { id: labelId },
    select: { status: true, voidReason: true },
  });
  if (!label) throw notFound();
  if (!stuckStatuses.includes(label.status as (typeof stuckStatuses)[number])) {
    throw new AppError("CONFLICT", "errors.shipping.labelNotStuck");
  }
  return voidLabelStep(db, actor, { labelId, reason: label.voidReason ?? "Retry" }, options);
}

/**
 * Releases a label the provider wouldn't void, for an admin who has checked it at the carrier (it
 * shipped, or the carrier bills it regardless). `WRITTEN_OFF` is not live; the row and its cost stay.
 */
export async function writeOffLabel(
  db: Db,
  actor: Actor,
  { labelId, reason }: WriteOffLabelInput,
  { now = new Date() }: QaOptions = {},
): Promise<LabelVoidStep> {
  assertCan(actor, "label.writeOff");
  const why = reason.trim();
  if (!why) throw new AppError("BAD_REQUEST", "errors.validation");
  return db.$transaction(async (tx) => {
    const found = await tx.shippingLabel.findUnique({
      where: { id: labelId },
      select: { package: { select: { orderId: true } } },
    });
    const orderId = found?.package?.orderId;
    if (!orderId) throw notFound();
    const order = await lockOrder(tx, orderId);

    // Read after the lock, so a concurrent retry that voided it is seen.
    const label = await tx.shippingLabel.findUniqueOrThrow({ where: { id: labelId } });
    if (!stuckStatuses.includes(label.status as (typeof stuckStatuses)[number])) {
      throw new AppError("CONFLICT", "errors.shipping.labelNotStuck");
    }
    await tx.shippingLabel.update({
      where: { id: labelId },
      data: { status: "WRITTEN_OFF", error: null },
    });
    await recordAudit(tx, actor, {
      entityType: "ShippingLabel",
      entityId: labelId,
      action: "label.writeOff",
      before: { status: label.status },
      after: { status: "WRITTEN_OFF", reason: why },
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return { orderId, status: "WRITTEN_OFF" } as const;
  });
}

/** The order's labels waiting for a retry or a write-off. */
export async function stuckLabels(
  db: Db,
  actor: Actor,
  { orderId }: { orderId: string },
): Promise<StuckLabels> {
  assertCan(actor, "order.repack");
  const labels = await db.shippingLabel.findMany({
    where: { status: { in: [...stuckStatuses] }, package: { orderId } },
    select: {
      id: true,
      status: true,
      error: true,
      voidReason: true,
      package: { select: { number: true } },
    },
    orderBy: [{ package: { number: "asc" } }, { createdAt: "asc" }],
  });
  const items = labels.map((l) => ({
    id: l.id,
    packageNumber: l.package?.number ?? 0,
    status: l.status as StuckLabels["labels"][number]["status"],
    error: l.error,
    voidReason: l.voidReason,
  }));
  return { labels: items, canWriteOff: can(actor, "label.writeOff") };
}
