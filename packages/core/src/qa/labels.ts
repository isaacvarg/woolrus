import type { MarkLabelNotBoughtInput, QaResult, VoidLabelInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { shippingErrorFromCause } from "../adapters/shipping/errors";
import { type ShippingProvider, withTimeout } from "../adapters/shipping/provider";
import { type AdapterFactories, createShippingProviders } from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { JOBS_SCHEMA, queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { type QaOptions, qaResult } from "./queries";

// Settling and voiding (SPEC-qa "Settling and voiding"). `shipping` will widen the QA-only check for repack (SPEC-qa).

/** One provider call, however long the provider takes to answer. */
export const VOID_TIMEOUT_MS = 30_000;

export type VoidLabelOptions = QaOptions & {
  /** The enabled providers; loaded from the database when omitted. */
  providers?: ShippingProvider[];
  adapters?: AdapterFactories;
  timeoutMs?: number;
};

/**
 * Voids an `ACTIVE` label of an order in QA. The intent (`VOID_REQUESTED`) commits before the
 * provider is called: approved → `VOIDED`; declined → `VOID_REJECTED`, still live; a transient
 * failure leaves `VOID_REQUESTED` and the same call can be repeated. The row is never deleted.
 */
export async function voidLabel(
  db: Db,
  actor: Actor,
  { labelId, reason }: VoidLabelInput,
  { now = new Date(), providers, adapters, timeoutMs = VOID_TIMEOUT_MS }: VoidLabelOptions = {},
): Promise<QaResult> {
  assertCan(actor, "label.void");
  const why = reason.trim();
  if (!why) throw new AppError("BAD_REQUEST", "errors.validation");
  const available = providers ?? (await createShippingProviders(db, adapters));

  const { orderId, providerLabelId, callVoid } = await db.$transaction(async (tx) => {
    const found = await tx.shippingLabel.findUnique({
      where: { id: labelId },
      select: { package: { select: { orderId: true } } },
    });
    const orderId = found?.package?.orderId;
    if (!orderId) throw notFound();
    const order = await lockOrder(tx, orderId);
    if (order.status !== "QA") throw new AppError("CONFLICT", "errors.qa.notQa");

    // Read after the lock, so a concurrent void can't be missed. VOID_REQUESTED is a repeat.
    const label = await tx.shippingLabel.findUniqueOrThrow({ where: { id: labelId } });
    if (label.status !== "ACTIVE" && label.status !== "VOID_REQUESTED") {
      throw new AppError("CONFLICT", "errors.qa.labelNotVoidable");
    }
    const provider = available.find((p) => p.id === label.provider);
    if (!provider?.capabilities.void || !provider.voidLabel || !label.providerLabelId) {
      throw new AppError("CONFLICT", "errors.qa.voidUnsupported");
    }

    await tx.shippingLabel.update({
      where: { id: labelId },
      data: {
        status: "VOID_REQUESTED",
        voidRequestedAt: now,
        voidedById: actor.userId,
        voidReason: why,
        error: null,
      },
    });
    await recordAudit(tx, actor, {
      entityType: "ShippingLabel",
      entityId: labelId,
      action: "label.void",
      before: { status: label.status },
      after: { status: "VOID_REQUESTED", reason: why },
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return {
      orderId,
      providerLabelId: label.providerLabelId,
      callVoid: provider.voidLabel.bind(provider),
    };
  });

  let outcome: { approved: boolean };
  try {
    outcome = await withTimeout(callVoid(providerLabelId), timeoutMs);
  } catch (cause) {
    // Stays VOID_REQUESTED: the void can be repeated.
    const error = shippingErrorFromCause("voidLabel", cause);
    throw new AppError("BAD_REQUEST", error.messageKey);
  }

  return db.$transaction(async (tx) => {
    const approved = outcome.approved;
    await tx.shippingLabel.update({
      where: { id: labelId },
      data: approved
        ? { status: "VOIDED", voidedAt: now }
        : { status: "VOID_REJECTED", error: "errors.qa.voidRejected" },
    });
    await recordAudit(tx, actor, {
      entityType: "ShippingLabel",
      entityId: labelId,
      action: approved ? "label.voided" : "label.voidRejected",
      after: { status: approved ? "VOIDED" : "VOID_REJECTED" },
      at: now,
    });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    await notifyOrderChanged(tx, order);
    return qaResult(tx, orderId, { now });
  });
}

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
 * for over ten minutes (a worker died mid-purchase), or bought but never stored. Labels waiting for a person are skipped, and
 * the per-order singleton key stops a second job while one is queued. Returns the orders queued.
 */
export async function reconcileLabels(
  db: Db,
  { now = new Date() }: { now?: Date } = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PURCHASE_MINUTES * 60_000);
  const stale = await db.shippingLabel.findMany({
    where: {
      OR: [
        {
          status: "PURCHASING",
          createdAt: { lt: cutoff },
          // Labels waiting for a person are skipped.
          AND: [{ OR: [{ error: null }, { error: { not: "errors.qa.purchaseUnknown" } }] }],
        },
        // Bought, but the PDF never reached our storage: the job only has to copy it.
        { status: "ACTIVE", storageKey: null, purchasedAt: { lt: cutoff } },
      ],
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
