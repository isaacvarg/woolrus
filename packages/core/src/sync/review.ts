import type { ExternalChange } from "@woolrus/contracts";
import { type Db, type DbTx, type Order, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, type UnmetCondition } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { recomputePriorities } from "../workflow/priority-rules";
import {
  type DismissedSummary,
  type ExternalChangeSummary,
  headerFields,
  writeLineChanges,
} from "./apply";
import type { ChangeSummary } from "./changes";

// An admin's Apply / Dismiss of a flagged store change (SPEC-store-sync "Reviewing a flagged
// change"). Apply never undoes floor work: header fields always go in, a line change only if the
// line can take it, and the store's status never (that's the workflow's cancel / resume / force).

export type ReviewInput = { orderId: string; expectedVersion: number };
export type ReviewOptions = { now?: Date };

export async function applyExternalChange(
  db: Db,
  actor: Actor,
  { orderId, expectedVersion }: ReviewInput,
  { now = new Date() }: ReviewOptions = {},
): Promise<Order> {
  assertCan(actor, "order.resolveExternalChange");
  return db.$transaction(async (tx) => {
    const { order, summary } = await lockFlagged(tx, orderId, expectedVersion);
    const { diff, incoming } = summary;

    const unmet = await unabsorbable(tx, order, diff.lines);
    if (unmet.length > 0) {
      throw new AppError("CONFLICT", "errors.sync.cannotApply", undefined, { unmet });
    }

    const header = headerFields(incoming);
    const before = Object.fromEntries(
      Object.keys(header).map((key) => [key, order[key as keyof typeof header]]),
    );
    await writeLineChanges(tx, orderId, incoming, diff.lines);
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { ...header, ...clearFlag, version: { increment: 1 } },
    });
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "order.externalChange.applied",
      before: { ...before, version: order.version } as Prisma.InputJsonValue,
      after: { ...header, lines: diff.lines, version: updated.version } as Prisma.InputJsonValue,
      at: now,
    });
    await recomputePriorities(tx, { orderIds: [orderId], now });
    await notifyOrderChanged(tx, { id: orderId, status: updated.status });
    // Priority may have moved: read the row back.
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

/** Clears the flag and keeps the order as it is. The store's version comes back on its next edit. */
export async function dismissExternalChange(
  db: Db,
  actor: Actor,
  { orderId, expectedVersion, reason }: ReviewInput & { reason: string },
  { now = new Date() }: ReviewOptions = {},
): Promise<Order> {
  assertCan(actor, "order.resolveExternalChange");
  const reasonText = reason.trim();
  if (!reasonText) {
    throw new AppError("BAD_REQUEST", "errors.validation", { reason: "errors.field.required" });
  }
  return db.$transaction(async (tx) => {
    const { summary } = await lockFlagged(tx, orderId, expectedVersion);
    // The flag goes; the dismissed store version stays, so only a newer change flags again.
    const dismissed: DismissedSummary = { dismissed: summary.incoming };
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        externalChangeDetectedAt: null,
        externalChangeSummary: dismissed as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "order.externalChange.dismissed",
      before: summary.diff as unknown as Prisma.InputJsonValue,
      after: { reason: reasonText, version: updated.version },
      at: now,
    });
    await notifyOrderChanged(tx, { id: orderId, status: updated.status });
    return updated;
  });
}

/** The flag as clients see it: the diff, never the store's data behind it. */
export function externalChangeOf(
  order: Pick<Order, "externalChangeDetectedAt" | "externalChangeSummary">,
): ExternalChange | null {
  const summary = order.externalChangeSummary as ExternalChangeSummary | null;
  if (!order.externalChangeDetectedAt || !summary) return null;
  return { detectedAt: order.externalChangeDetectedAt, diff: summary.diff };
}

/** Statuses whose remaining gates never compare line quantities with what was picked and packed. */
const pastPacking: ReadonlySet<string> = new Set(["QA", "READY", "COMPLETED", "CANCELLED"]);

const clearFlag = { externalChangeDetectedAt: null, externalChangeSummary: Prisma.DbNull };

async function lockFlagged(tx: DbTx, orderId: string, expectedVersion: number) {
  const locked = await lockOrder(tx, orderId);
  if (locked.version !== expectedVersion) throw new AppError("CONFLICT", "errors.workflow.stale");
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const summary = order.externalChangeSummary as ExternalChangeSummary | null;
  if (!order.externalChangeDetectedAt || !summary) {
    throw new AppError("CONFLICT", "errors.sync.notFlagged");
  }
  return { order, summary };
}

/**
 * The line changes that would undo floor work. The summary's lines are current: lines only change
 * under the order lock, by sync (which rewrites the summary) or by this Apply.
 */
async function unabsorbable(
  tx: DbTx,
  order: Pick<Order, "id" | "status" | "heldFromStatus">,
  lines: ChangeSummary["lines"],
): Promise<UnmetCondition[]> {
  const unmet = (key: string, params: UnmetCondition["params"]): UnmetCondition => ({
    messageKey: `errors.sync.unmet.${key}` as UnmetCondition["messageKey"],
    params,
  });
  const found: UnmetCondition[] = [];

  // More to ship is only caught by the Picking and Packing gates; QA and Ready check packages and
  // labels, not quantities, so past Packing an added or raised line would ship short.
  const stage = order.status === "ON_HOLD" ? order.heldFromStatus : order.status;
  if (stage && pastPacking.has(stage)) {
    for (const q of lines.quantity.filter((q) => q.to > q.from)) {
      found.push(unmet("pastPacking", { line: q.name }));
    }
    for (const added of lines.added) found.push(unmet("pastPacking", { line: added.name }));
  }

  const lowered = lines.quantity.filter((q) => q.to < q.from);
  const ids = [...lowered, ...lines.removed].map((l) => l.wooLineItemId);
  if (ids.length === 0) return found;
  const rows = await tx.orderItem.findMany({
    where: { orderId: order.id, wooLineItemId: { in: ids } },
    select: {
      wooLineItemId: true,
      name: true,
      pickedQuantity: true,
      packageItems: { select: { quantity: true } },
      voids: { select: { undoneAt: true } },
      _count: { select: { notes: true, qualityIssues: true, returnItems: true } },
    },
  });
  const byWooId = new Map(rows.map((row) => [row.wooLineItemId, row]));
  for (const { wooLineItemId, to } of lowered) {
    const row = byWooId.get(wooLineItemId);
    if (!row) continue;
    const line = row.name;
    const packed = row.packageItems.reduce((sum, p) => sum + p.quantity, 0);
    if (row.voids.some((v) => v.undoneAt === null)) found.push(unmet("lineVoided", { line }));
    if (to < row.pickedQuantity) {
      found.push(unmet("belowPicked", { line, to, picked: row.pickedQuantity }));
    }
    if (to < packed) found.push(unmet("belowPacked", { line, to, packed }));
  }
  for (const { wooLineItemId } of lines.removed) {
    const row = byWooId.get(wooLineItemId);
    if (!row) continue;
    const line = row.name;
    // Deleting the line would cascade away anything attached to it, history included.
    const { notes, qualityIssues, returnItems } = row._count;
    if (row.pickedQuantity > 0 || row.packageItems.length > 0) {
      found.push(unmet("removedStarted", { line }));
    } else if (row.voids.length + notes + qualityIssues + returnItems > 0) {
      found.push(unmet("removedHasRecords", { line }));
    }
  }
  return found;
}
