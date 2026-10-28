import type { Db, DbTx, Order, WorkflowStatus } from "@woolrus/db";
import { recordAudit } from "../audit";
import { requestRateFetch } from "../carriers/rates";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { claimExpiryMinutes, holdsClaim, isClaimLive } from "./claims";
import { evaluateGate, loadGateSnapshot } from "./gates";
import { lockOrder } from "./lock";
import { ruleFor, type TransitionKind, transitionFor } from "./machine";
import { notifyOrderChanged } from "./notify";
import { holderName } from "./people";

// The only code that writes Order.status (SPEC-workflow "Transition service"). Stage modules call
// `transition` with their own tx so their writes and the move commit or roll back together.

export type TransitionInput = {
  orderId: string;
  expectedVersion: number;
  to: WorkflowStatus;
  kind: TransitionKind;
  reason?: string;
};

export type TransitionOptions = {
  now?: Date;
  /**
   * A move that needs the actor's claim accepts one past its expiry, as long as it's still theirs.
   * For the label job's final move, since the claim was refreshed when the purchase began.
   */
  ignoreClaimExpiry?: boolean;
};

const activeStatuses: readonly WorkflowStatus[] = ["PENDING", "PICKING", "PACKING", "QA", "READY"];

export async function transition(
  tx: DbTx,
  actor: Actor,
  { orderId, expectedVersion, to, kind, reason }: TransitionInput,
  { now = new Date(), ignoreClaimExpiry = false }: TransitionOptions = {},
): Promise<Order> {
  const reasonText = reason?.trim() || null;

  // Permission first: it depends only on the kind, so a forbidden caller learns nothing about the order.
  const rule = ruleFor(kind);
  assertCan(actor, rule.permission);
  if (rule.reasonRequired && !reasonText) {
    throw new AppError("BAD_REQUEST", "errors.validation", { reason: "errors.field.required" });
  }

  // Settings before the order lock, as in claims.ts: the same lock order everywhere, or a claim and
  // a transition racing on one order can deadlock.
  const expiryMinutes = await claimExpiryMinutes(tx);
  const order = await lockOrder(tx, orderId);
  if (order.version !== expectedVersion) throw new AppError("CONFLICT", "errors.workflow.stale");

  const move = transitionFor(order.status, to, kind);
  if (kind === "resume" && to !== order.heldFromStatus) {
    throw new AppError("CONFLICT", "errors.workflow.illegalTransition");
  }

  if (move.claim !== "none") {
    // The system actor has no user to hold or take a claim, so claim moves are never its to make.
    if (actor.userId === null) throw new AppError("CONFLICT", "errors.workflow.claimRequired");
    const live =
      ignoreClaimExpiry && move.claim === "holds"
        ? order.claimedById !== null
        : isClaimLive(order, expiryMinutes, now);
    if (move.claim === "holds" && (!live || !holdsClaim(actor, order.claimedById))) {
      throw new AppError("CONFLICT", "errors.workflow.claimRequired");
    }
    // Taking the claim never silently overwrites someone else's live one: that's a takeover.
    if (move.claim === "claims" && live && !holdsClaim(actor, order.claimedById)) {
      throw new AppError("CONFLICT", "errors.workflow.claimedByOther", undefined, {
        params: { name: await holderName(tx, order.claimedById) },
      });
    }
  }

  if (move.gate) {
    const unmet = evaluateGate(move.gate, await loadGateSnapshot(tx, orderId));
    if (unmet.length > 0)
      throw new AppError("CONFLICT", "errors.workflow.gateFailed", undefined, { unmet });
  }

  const claims = move.claim === "claims";
  const updated = await tx.order.update({
    where: { id: orderId },
    data: {
      status: to,
      statusChangedAt: now,
      version: { increment: 1 },
      claimedById: claims ? actor.userId : null,
      claimedAt: claims ? now : null,
      holdReason: to === "ON_HOLD" ? reasonText : null,
      heldFromStatus:
        to === "ON_HOLD" && activeStatuses.includes(order.status) ? order.status : null,
      completedAt: to === "COMPLETED" ? now : null,
    },
  });

  await tx.orderStageEvent.create({
    data: {
      orderId,
      fromStatus: order.status,
      toStatus: to,
      actorId: actor.userId,
      stationId: actor.stationId,
      reason: reasonText,
      at: now,
    },
  });
  await recordAudit(tx, actor, {
    entityType: "Order",
    entityId: orderId,
    action: `order.${kind}`,
    before: { status: order.status, version: order.version },
    after: { status: to, version: updated.version, ...(reasonText ? { reason: reasonText } : {}) },
    at: now,
  });
  await notifyOrderChanged(tx, { id: orderId, status: to });

  // FR-PACK-07: rates for every package, on this transaction so a rolled-back move asks for none.
  if (kind === "completePacking") {
    return { ...updated, rateGeneration: await requestRateFetch(tx, orderId) };
  }
  return updated;
}

export type StageInput = { orderId: string; expectedVersion: number };

const stageMove =
  (kind: TransitionKind, to: WorkflowStatus) =>
  (db: Db, actor: Actor, input: StageInput, options?: TransitionOptions): Promise<Order> =>
    db.$transaction((tx) => transition(tx, actor, { ...input, to, kind }, options));

/** Pending → Picking; the actor takes the claim. */
export const beginPicking = stageMove("beginPicking", "PICKING");
/** Picking → Packing; needs the actor's live claim and the **picked** gate. */
export const completePicking = stageMove("completePicking", "PACKING");
/** Packing → QA; needs the actor's live claim and the **packed** gate. */
export const completePacking = stageMove("completePacking", "QA");
/** QA → Ready; needs the actor's live claim and the **verified** gate. */
export const completeQa = stageMove("completeQa", "READY");

export type ReasonInput = StageInput & { reason: string };

/** Any active stage → On Hold, with a reason. */
export function hold(
  db: Db,
  actor: Actor,
  input: ReasonInput,
  options?: TransitionOptions,
): Promise<Order> {
  return db.$transaction((tx) =>
    transition(tx, actor, { ...input, to: "ON_HOLD", kind: "hold" }, options),
  );
}

/** On Hold → the stage it was held from. */
export function resume(
  db: Db,
  actor: Actor,
  input: StageInput,
  options?: TransitionOptions,
): Promise<Order> {
  return db.$transaction(async (tx) => {
    const held = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { heldFromStatus: true },
    });
    // Unlocked read: `transition` re-checks it under the row lock. The fallback lets it refuse the move
    // (or report not found) in its usual order.
    const to = held?.heldFromStatus ?? "PENDING";
    return transition(tx, actor, { ...input, to, kind: "resume" }, options);
  });
}

/** Any non-terminal status → Cancelled, with a reason and no live labels. */
export function cancel(
  db: Db,
  actor: Actor,
  input: ReasonInput,
  options?: TransitionOptions,
): Promise<Order> {
  return db.$transaction((tx) =>
    transition(tx, actor, { ...input, to: "CANCELLED", kind: "cancel" }, options),
  );
}

/** Admin override to any other status, with a reason. Skips gates, except reopening a Completed order with live labels. */
export function forceStatus(
  db: Db,
  actor: Actor,
  input: ReasonInput & { to: WorkflowStatus },
  options?: TransitionOptions,
): Promise<Order> {
  return db.$transaction((tx) => transition(tx, actor, { ...input, kind: "forceStatus" }, options));
}

/** Ready → Completed. For `shipping`, inside its own transaction; no claim needed (batches). */
export function ship(
  tx: DbTx,
  actor: Actor,
  input: StageInput,
  options?: TransitionOptions,
): Promise<Order> {
  return transition(tx, actor, { ...input, to: "COMPLETED", kind: "ship" }, options);
}

/** Ready → Packing, with a reason and no live labels. For `shipping`, inside its own transaction. */
export function repack(
  tx: DbTx,
  actor: Actor,
  input: ReasonInput,
  options?: TransitionOptions,
): Promise<Order> {
  return transition(tx, actor, { ...input, to: "PACKING", kind: "repack" }, options);
}
