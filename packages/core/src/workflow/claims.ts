import { CLAIM_MANY_MAX } from "@woolrus/contracts";
import type { Db, DbTx, Order, WorkflowStatus } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { recordAudit } from "../audit";
import { AppError, type AppErrorKind, forbidden, type OrderFailure } from "../errors";
import { type Actor, can, type Permission } from "../permissions";
import { loadSettings } from "../settings/service";
import { type LockedOrder, lockOrder, lockOrders } from "./lock";
import { notifyOrderChanged } from "./notify";
import { holderName } from "./people";

// A claim is Order.claimedById + claimedAt (SPEC-workflow "Claims"). Expiry is lazy: a claim older
// than Settings.claimExpiryMinutes reads as absent, and nothing clears it. Claims bump the version
// and are audited, but write no stage event: the status doesn't change.

export type ClaimOptions = { now?: Date };
export type ClaimInput = { orderId: string; expectedVersion: number };

/** Who may claim an order, by its status. Other statuses can't be claimed. */
export const claimPermission: Partial<Record<WorkflowStatus, Permission>> = {
  PENDING: "order.pick",
  PICKING: "order.pick",
  PACKING: "order.pack",
  QA: "order.qa",
};

export async function claimExpiryMinutes(tx: DbTx): Promise<number> {
  return (await loadSettings(tx)).claimExpiryMinutes;
}

export function isClaimLive(
  order: { claimedById: string | null; claimedAt: Date | null },
  expiryMinutes: number,
  now: Date,
): boolean {
  return (
    order.claimedById !== null &&
    order.claimedAt !== null &&
    order.claimedAt.getTime() + expiryMinutes * 60_000 > now.getTime()
  );
}

type Refusal = {
  kind: AppErrorKind;
  messageKey: ErrorCode;
  params: Record<string, string | number>;
};

async function refusalFor(
  tx: DbTx,
  actor: Actor,
  order: LockedOrder,
  expectedVersion: number,
  { live, takeOver }: { live: boolean; takeOver: boolean },
): Promise<Refusal | null> {
  const permission = claimPermission[order.status];
  if (!permission)
    return { kind: "CONFLICT", messageKey: "errors.workflow.notClaimable", params: {} };
  if (!can(actor, permission))
    return { kind: "FORBIDDEN", messageKey: "errors.forbidden", params: {} };
  if (order.version !== expectedVersion) {
    return { kind: "CONFLICT", messageKey: "errors.workflow.stale", params: {} };
  }
  if (live && !takeOver && order.claimedById !== actor.userId) {
    return {
      kind: "CONFLICT",
      messageKey: "errors.workflow.claimedByOther",
      params: { name: await holderName(tx, order.claimedById) },
    };
  }
  return null;
}

async function writeClaim(
  tx: DbTx,
  actor: Actor,
  order: LockedOrder,
  { action, live, now }: { action: "order.claim" | "order.takeOver"; live: boolean; now: Date },
): Promise<Order> {
  const updated = await tx.order.update({
    where: { id: order.id },
    data: { claimedById: actor.userId, claimedAt: now, version: { increment: 1 } },
  });
  await recordAudit(tx, actor, {
    entityType: "Order",
    entityId: order.id,
    action,
    before: { claimedById: live ? order.claimedById : null, version: order.version },
    after: { claimedById: actor.userId, version: updated.version },
    at: now,
  });
  await notifyOrderChanged(tx, { id: order.id, status: order.status });
  return updated;
}

async function claimOne(
  db: Db,
  actor: Actor,
  { orderId, expectedVersion }: ClaimInput,
  { now, takeOver }: { now: Date; takeOver: boolean },
): Promise<Order> {
  return db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const order = await lockOrder(tx, orderId);
    const live = isClaimLive(order, expiry, now);
    const refusal = await refusalFor(tx, actor, order, expectedVersion, { live, takeOver });
    if (refusal)
      throw new AppError(refusal.kind, refusal.messageKey, undefined, { params: refusal.params });
    return writeClaim(tx, actor, order, {
      action: takeOver ? "order.takeOver" : "order.claim",
      live,
      now,
    });
  });
}

/** Claims an order for the actor. Fails with the holder's name if someone else has a live claim. */
export async function claim(
  db: Db,
  actor: Actor,
  input: ClaimInput,
  { now = new Date() }: ClaimOptions = {},
) {
  return claimOne(db, actor, input, { now, takeOver: false });
}

/** Claims an order over someone else's live claim; the UI confirms first, naming the holder. */
export async function takeOver(
  db: Db,
  actor: Actor,
  { confirm, ...input }: ClaimInput & { confirm: boolean },
  { now = new Date() }: ClaimOptions = {},
) {
  if (confirm !== true) throw new AppError("BAD_REQUEST", "errors.workflow.takeOverConfirm");
  return claimOne(db, actor, input, { now, takeOver: true });
}

/** All or nothing: claims every order, or none and reports why each refused one failed. */
export async function claimMany(
  db: Db,
  actor: Actor,
  { orders }: { orders: readonly { id: string; expectedVersion: number }[] },
  { now = new Date() }: ClaimOptions = {},
): Promise<Order[]> {
  const ids = orders.map((o) => o.id);
  if (orders.length === 0 || orders.length > CLAIM_MANY_MAX || new Set(ids).size !== ids.length) {
    throw new AppError("BAD_REQUEST", "errors.validation", { orders: "errors.field.invalid" });
  }

  return db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const locked = new Map((await lockOrders(tx, ids)).map((o) => [o.id, o]));

    const failures: OrderFailure[] = [];
    for (const { id, expectedVersion } of orders) {
      const order = locked.get(id);
      const refusal = order
        ? await refusalFor(tx, actor, order, expectedVersion, {
            live: isClaimLive(order, expiry, now),
            takeOver: false,
          })
        : { messageKey: "errors.notFound" as const, params: {} };
      if (refusal)
        failures.push({ orderId: id, messageKey: refusal.messageKey, params: refusal.params });
    }
    if (failures.length > 0) {
      throw new AppError("CONFLICT", "errors.workflow.claimManyFailed", undefined, { failures });
    }

    const claimed: Order[] = [];
    for (const { id } of orders) {
      const order = locked.get(id) as LockedOrder;
      claimed.push(
        await writeClaim(tx, actor, order, {
          action: "order.claim",
          live: isClaimLive(order, expiry, now),
          now,
        }),
      );
    }
    return claimed;
  });
}

/** Gives up a claim: the holder or an Admin. Without a live claim there is nothing to release. */
export async function release(
  db: Db,
  actor: Actor,
  { orderId }: { orderId: string },
  { now = new Date() }: ClaimOptions = {},
): Promise<Order> {
  return db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const order = await lockOrder(tx, orderId);
    if (!isClaimLive(order, expiry, now))
      return tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.claimedById !== actor.userId && !actor.roles.includes("ADMIN")) throw forbidden();

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { claimedById: null, claimedAt: null, version: { increment: 1 } },
    });
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "order.release",
      before: { claimedById: order.claimedById, version: order.version },
      after: { claimedById: null, version: updated.version },
      at: now,
    });
    await notifyOrderChanged(tx, { id: orderId, status: order.status });
    return updated;
  });
}

/**
 * Keeps the actor's live claim from expiring while they work (picking, packing…). No version bump
 * and no audit: activity isn't a change anyone else needs to reload for. False if they don't hold it.
 */
export async function touchClaim(
  tx: DbTx,
  actor: Actor,
  orderId: string,
  { now = new Date() }: ClaimOptions = {},
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - (await claimExpiryMinutes(tx)) * 60_000);
  const { count } = await tx.order.updateMany({
    where: { id: orderId, claimedById: actor.userId, claimedAt: { gt: cutoff } },
    data: { claimedAt: now },
  });
  return count > 0;
}
