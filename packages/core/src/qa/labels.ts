import type { QaResult, VoidLabelInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { shippingErrorFromCause } from "../adapters/shipping/errors";
import { type ShippingProvider, withTimeout } from "../adapters/shipping/provider";
import { type AdapterFactories, createShippingProviders } from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { type QaOptions, qaResult } from "./queries";

// Settling and voiding (SPEC-qa "Settling and voiding"). `shipping` reuses `voidLabel` for repack.

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
