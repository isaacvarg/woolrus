import type {
  ClaimManyInput,
  DismissExternalChangeInput,
  ForceStatusInput,
  OrderDetail,
  OrderReasonInput,
  OrderVersionInput,
  TakeOverInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Order } from "@woolrus/db";
import type { Actor } from "../permissions";
import { applyExternalChange, dismissExternalChange } from "../sync/review";
import { isAllVoided } from "./gates";
import { claim, claimExpiryMinutes, claimMany, isClaimLive, release, takeOver } from "./claims";
import { displayName, nameFields } from "./people";
import {
  beginPicking,
  cancel,
  completePacking,
  completePicking,
  completeQa,
  forceStatus,
  hold,
  resume,
} from "./service";

/** Orders as the API returns them. The claim shows only while it's live, with the holder's name. */
export async function toOrderDetails(
  db: DbTx,
  orders: readonly Order[],
  { now = new Date() }: { now?: Date } = {},
): Promise<OrderDetail[]> {
  const expiry = await claimExpiryMinutes(db);
  const holderIds = orders.flatMap((o) =>
    o.claimedById && isClaimLive(o, expiry, now) ? [o.claimedById] : [],
  );
  const holders = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(holderIds)] } },
        select: { id: true, ...nameFields },
      })
    ).map((u) => [u.id, displayName(u)]),
  );

  const items = await db.orderItem.findMany({
    where: { orderId: { in: orders.map((o) => o.id) } },
    select: {
      orderId: true,
      quantity: true,
      voids: { where: { undoneAt: null }, select: { quantity: true } },
    },
  });
  const linesByOrder = new Map<string, { quantity: number; voidedQuantity: number }[]>();
  for (const it of items) {
    const lines = linesByOrder.get(it.orderId) ?? [];
    lines.push({
      quantity: it.quantity,
      voidedQuantity: it.voids.reduce((sum, v) => sum + v.quantity, 0),
    });
    linesByOrder.set(it.orderId, lines);
  }

  return orders.map((o) => {
    const holder = o.claimedById ? holders.get(o.claimedById) : undefined;
    return {
      id: o.id,
      number: o.number,
      customerName: o.customerName,
      orderedAt: o.orderedAt,
      shippingMethod: o.shippingMethod,
      status: o.status,
      statusChangedAt: o.statusChangedAt,
      priority: o.priority,
      holdReason: o.holdReason,
      heldFromStatus: o.heldFromStatus,
      claim:
        holder !== undefined && o.claimedById && o.claimedAt
          ? { userId: o.claimedById, userName: holder, at: o.claimedAt }
          : null,
      completedAt: o.completedAt,
      externalChange: o.externalChangeDetectedAt !== null,
      allVoided: isAllVoided(linesByOrder.get(o.id) ?? []),
      version: o.version,
    };
  });
}

async function detailOf(db: Db, order: Promise<Order>): Promise<OrderDetail> {
  const [detail] = await toOrderDetails(db, [await order]);
  return detail as OrderDetail;
}

/**
 * The order mutations in the API's shape: contract input in, OrderDetail out. Each is one call to
 * the workflow service, which does every check; this only renames `id` and presents the result.
 */
export const orderMutations = {
  beginPicking: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, beginPicking(db, actor, { orderId: id, expectedVersion })),
  completePicking: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, completePicking(db, actor, { orderId: id, expectedVersion })),
  completePacking: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, completePacking(db, actor, { orderId: id, expectedVersion })),
  completeQa: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, completeQa(db, actor, { orderId: id, expectedVersion })),
  hold: (db: Db, actor: Actor, { id, ...input }: OrderReasonInput) =>
    detailOf(db, hold(db, actor, { orderId: id, ...input })),
  resume: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, resume(db, actor, { orderId: id, expectedVersion })),
  cancel: (db: Db, actor: Actor, { id, ...input }: OrderReasonInput) =>
    detailOf(db, cancel(db, actor, { orderId: id, ...input })),
  forceStatus: (db: Db, actor: Actor, { id, ...input }: ForceStatusInput) =>
    detailOf(db, forceStatus(db, actor, { orderId: id, ...input })),
  claim: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, claim(db, actor, { orderId: id, expectedVersion })),
  release: (db: Db, actor: Actor, { id }: { id: string }) =>
    detailOf(db, release(db, actor, { orderId: id })),
  takeOver: (db: Db, actor: Actor, { id, ...input }: TakeOverInput) =>
    detailOf(db, takeOver(db, actor, { orderId: id, ...input })),
  applyExternalChange: (db: Db, actor: Actor, { id, expectedVersion }: OrderVersionInput) =>
    detailOf(db, applyExternalChange(db, actor, { orderId: id, expectedVersion })),
  dismissExternalChange: (db: Db, actor: Actor, { id, ...input }: DismissExternalChangeInput) =>
    detailOf(db, dismissExternalChange(db, actor, { orderId: id, ...input })),
  claimMany: async (db: Db, actor: Actor, input: ClaimManyInput) =>
    toOrderDetails(db, await claimMany(db, actor, input)),
};
