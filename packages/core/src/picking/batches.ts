import {
  type CreatePickBatchInput,
  type LineAttribute,
  type MyPicks,
  PICK_BATCH_MIN_ORDERS,
  type PickBatch,
  type PickBatchChip,
  type PickBatchGroup,
  type PickBatchLeft,
  type PickBatchMemberState,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, forbidden, notFound, type OrderFailure } from "../errors";
import { withIdempotency } from "../idempotency";
import { lineNoteCounts } from "../notes/targets";
import { type Actor, assertCan, type UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { claimExpiryMinutes, holdsClaim, isClaimLive, touchClaim } from "../workflow/claims";
import { lockOrders } from "../workflow/lock";
import { displayName, holderName, nameFields } from "../workflow/people";
import { transition } from "../workflow/service";
import { normalizeCode } from "./codes";
import { isDone, isWorkLine, type LineRow, lineInclude, toPickLine } from "./service";
import { pickOrder } from "./sort";

// Pick batches (SPEC-picking "Pick batches"). A batch is stored so it survives a reload or a change of
// tablet, but workflow knows nothing about it: a member is live only while its order is Picking with
// the owner's live claim, so completing, holding or taking an order over elsewhere just makes it leave.

export type BatchOptions = { now?: Date };

export const batchInclude = {
  owner: { select: { id: true, ...nameFields } },
  orders: {
    orderBy: { slot: "asc" },
    include: {
      order: {
        select: {
          id: true,
          number: true,
          customerName: true,
          status: true,
          version: true,
          claimedById: true,
          claimedAt: true,
          claimedBy: { select: nameFields },
        },
      },
    },
  },
} as const satisfies Prisma.PickBatchInclude;

type BatchRow = Prisma.PickBatchGetPayload<{ include: typeof batchInclude }>;
export type MemberRow = BatchRow["orders"][number];

export function memberState(
  member: MemberRow,
  ownerId: string,
  expiry: number,
  now: Date,
): PickBatchMemberState {
  return member.removedAt ? "removed" : leftReason(member, ownerId, expiry, now) ? "left" : "live";
}

/** Why a member that wasn't removed has left the batch, or null while it is live. */
function leftReason(
  { order }: MemberRow,
  ownerId: string,
  expiry: number,
  now: Date,
): PickBatchLeft | null {
  if (order.status !== "PICKING") return { reason: "status" };
  if (!isClaimLive(order, expiry, now)) return { reason: "claimExpired" };
  if (order.claimedById !== ownerId) {
    return { reason: "takenOver", name: order.claimedBy ? displayName(order.claimedBy) : "" };
  }
  return null;
}

function toPickBatch(
  row: BatchRow,
  groups: PickBatchGroup[],
  expiry: number,
  now: Date,
): PickBatch {
  return {
    id: row.id,
    number: row.number,
    owner: { id: row.owner.id, name: displayName(row.owner) },
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    members: row.orders.map((member) => {
      const state = memberState(member, row.ownerId, expiry, now);
      return {
        slot: member.slot,
        orderId: member.order.id,
        number: member.order.number,
        customerName: member.order.customerName,
        status: member.order.status,
        version: member.order.version,
        state,
        left: state === "left" ? leftReason(member, row.ownerId, expiry, now) : null,
      };
    }),
    groups,
  };
}

/** What's on the shelf: the variation, else the product, else the SKU as a scanner reads it, else the name. */
function shelfKey(row: LineRow): string {
  if (row.variationId) return `variation:${row.variationId}`;
  if (row.productId) return `product:${row.productId}`;
  const sku = normalizeCode(row.sku ?? "");
  return sku ? `sku:${sku}` : `name:${row.name.trim().toLowerCase()}`;
}

const sameAttributes = (a: LineAttribute[], b: LineAttribute[]) =>
  a.length === b.length && a.every((x, i) => x.name === b[i]?.name && x.option === b[i]?.option);

/**
 * The batch pick list (SPEC-picking "Batch list"): the live members' lines grouped by what's on the
 * shelf, groups in pick order with finished ones last, chips by slot with finished ones last.
 */
async function batchGroups(tx: DbTx, live: MemberRow[]): Promise<PickBatchGroup[]> {
  if (live.length === 0) return [];
  const orderIds = live.map((m) => m.order.id);
  const members = new Map(live.map((m) => [m.order.id, m]));
  const [rows, notes] = await Promise.all([
    tx.orderItem.findMany({ where: { orderId: { in: orderIds } }, include: lineInclude }),
    lineNoteCounts(tx, orderIds),
  ]);

  const byKey = new Map<string, PickBatchChip[]>();
  for (const row of rows.filter(isWorkLine)) {
    const member = members.get(row.orderId) as MemberRow;
    const chip = {
      slot: member.slot,
      orderId: row.orderId,
      number: member.order.number,
      line: toPickLine(row, notes.get(row.id) ?? 0),
    };
    const key = shelfKey(row);
    byKey.set(key, [...(byKey.get(key) ?? []), chip]);
  }

  const groups = [...byKey].map(([key, chips]): PickBatchGroup & { id: string } => {
    chips.sort(
      (a, b) =>
        Number(isDone(a.line.pickStatus)) - Number(isDone(b.line.pickStatus)) || a.slot - b.slot,
    );
    // The first chip in pick order stands for the group, so a bin on any of them sorts it.
    const [lead] = pickOrder(chips.map((c) => c.line)) as [PickBatchChip["line"]];
    const attributes = chips.every((c) => sameAttributes(c.line.attributes, lead.attributes))
      ? lead.attributes
      : null;
    return {
      id: lead.id,
      key,
      name: lead.name,
      sku: lead.sku,
      imageUrl: lead.imageUrl,
      binLocation: lead.binLocation,
      attributes,
      quantity: chips.reduce((sum, c) => sum + c.line.quantity, 0),
      remaining: chips.reduce(
        (sum, c) => sum + (isDone(c.line.pickStatus) ? 0 : c.line.quantity - c.line.pickedQuantity),
        0,
      ),
      chips,
    };
  });
  // Groups with nothing left move below the rest; otherwise pick order (the sort is stable).
  return pickOrder(groups)
    .sort((a, b) => Number(a.remaining === 0) - Number(b.remaining === 0))
    .map(({ id: _, ...group }) => group);
}

/**
 * Closes an open batch none of whose members is live, and marks its rows removed so their orders can
 * join another batch (the one-open-batch-per-order index). Batches close lazily, on the next read or
 * write, like claims expire. Returns whether the batch is (now) closed.
 */
export async function closeIfSpent(
  tx: DbTx,
  actor: Actor,
  row: BatchRow,
  expiry: number,
  now: Date,
): Promise<boolean> {
  if (row.closedAt) return true;
  if (row.orders.some((m) => memberState(m, row.ownerId, expiry, now) === "live")) return false;
  // Guarded on closedAt so two readers closing at once audit it once.
  const { count } = await tx.pickBatch.updateMany({
    where: { id: row.id, closedAt: null },
    data: { closedAt: now },
  });
  await tx.pickBatchOrder.updateMany({
    where: { batchId: row.id, removedAt: null },
    data: { removedAt: now },
  });
  if (count > 0) {
    await recordAudit(tx, actor, {
      entityType: "PickBatch",
      entityId: row.id,
      action: "pickBatch.close",
      after: { reason: "noLiveOrders" },
      at: now,
    });
  }
  return true;
}

/** The batch as it stands, closing it first if nothing in it is live any more. */
async function readBatch(
  tx: DbTx,
  actor: Actor,
  id: string,
  expiry: number,
  now: Date,
): Promise<PickBatch> {
  const row = await tx.pickBatch.findUnique({ where: { id }, include: batchInclude });
  if (!row) throw notFound();
  if (!row.closedAt && (await closeIfSpent(tx, actor, row, expiry, now))) {
    return readBatch(tx, actor, id, expiry, now);
  }
  const live = row.closedAt
    ? []
    : row.orders.filter((m) => memberState(m, row.ownerId, expiry, now) === "live");
  return toPickBatch(row, await batchGroups(tx, live), expiry, now);
}

export function assertMayPick(actor: Actor): asserts actor is UserActor {
  assertCan(actor, "order.pick");
  // The system actor has no user to own a batch or hold claims.
  if (actor.userId === null) throw forbidden();
}

/**
 * Why one Picking order can't join the batch, or null when it can (Pending orders are begun through
 * `transition` instead). Someone else's claim is reported before a stale version: beginning the
 * order is what changed its version, and the holder's name tells the picker more.
 */
async function pickingRefusal(
  tx: DbTx,
  actor: UserActor,
  order: Awaited<ReturnType<typeof lockOrders>>[number],
  expectedVersion: number,
  { expiry, now }: { expiry: number; now: Date },
): Promise<Omit<OrderFailure, "orderId"> | null> {
  const live = isClaimLive(order, expiry, now);
  if (live && !holdsClaim(actor, order.claimedById)) {
    return {
      messageKey: "errors.workflow.claimedByOther",
      params: { name: await holderName(tx, order.claimedById) },
    };
  }
  if (order.version !== expectedVersion) {
    return { messageKey: "errors.workflow.stale", params: {} };
  }
  return live ? null : { messageKey: "errors.picking.claimRequired", params: {} };
}

/**
 * **Pick together**: begins picking every order for the actor and stores them as one batch, or does
 * nothing and reports why each refused order failed (like `claimMany`). Each order must be Pending
 * (begun through workflow's `transition`) or already Picking with the actor's live claim.
 */
export async function createBatch(
  db: Db,
  actor: Actor,
  { orders, idempotencyKey }: CreatePickBatchInput,
  { now = new Date() }: BatchOptions = {},
): Promise<PickBatch> {
  assertMayPick(actor);
  const ids = orders.map((o) => o.id);
  if (orders.length < PICK_BATCH_MIN_ORDERS || new Set(ids).size !== ids.length) {
    throw new AppError("BAD_REQUEST", "errors.validation", { orders: "errors.field.invalid" });
  }

  return db.$transaction(async (tx) => {
    const { id } = await withIdempotency(
      tx,
      idempotencyKey,
      "pickBatches.create",
      actor,
      async () => {
        // One picker's creates run one at a time, so two at once can't both pass the open-batch check
        // (the partial unique index would turn the loser into a 500). Taken before any row lock, and
        // nothing else takes it, so it can't join a deadlock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pick-batch:${actor.userId}`}))`;

        // Settings before the order locks: the lock order workflow uses everywhere.
        const settings = await loadSettings(tx);
        const expiry = settings.claimExpiryMinutes;
        if (orders.length > settings.pickBatchMaxOrders) {
          throw new AppError("BAD_REQUEST", "errors.picking.batchTooLarge", undefined, {
            params: { max: settings.pickBatchMaxOrders },
          });
        }

        const open = await tx.pickBatch.findFirst({
          where: { ownerId: actor.userId, closedAt: null },
          include: batchInclude,
        });
        if (open && !(await closeIfSpent(tx, actor, open, expiry, now))) {
          throw new AppError("CONFLICT", "errors.picking.batchOpen");
        }

        // In id order, so two batches over the same orders can't deadlock; transition re-locks each
        // row, which it already holds.
        const locked = new Map((await lockOrders(tx, ids)).map((o) => [o.id, o]));
        const failures: OrderFailure[] = [];
        const alreadyPicking: string[] = [];
        for (const { id: orderId, expectedVersion } of orders) {
          const order = locked.get(orderId);
          if (!order) {
            failures.push({ orderId, messageKey: "errors.notFound", params: {} });
          } else if (order.status === "PICKING") {
            const refusal = await pickingRefusal(tx, actor, order, expectedVersion, {
              expiry,
              now,
            });
            if (refusal) failures.push({ orderId, ...refusal });
            else alreadyPicking.push(orderId);
          } else {
            // Refusals throw before transition writes anything, so the transaction stays usable and
            // the remaining orders are still checked. Any failure rolls back the ones that moved.
            try {
              await transition(
                tx,
                actor,
                { orderId, expectedVersion, to: "PICKING", kind: "beginPicking" },
                { now },
              );
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              failures.push({ orderId, messageKey: error.messageKey, params: error.params ?? {} });
            }
          }
        }
        if (failures.length > 0) {
          throw new AppError("CONFLICT", "errors.picking.batchFailed", undefined, { failures });
        }
        for (const orderId of alreadyPicking) await touchClaim(tx, actor, orderId, { now });

        // Slots follow the queue (priority, then oldest) and are never renumbered.
        const queued = await tx.order.findMany({
          where: { id: { in: ids } },
          select: { id: true },
          orderBy: [{ priority: "desc" }, { orderedAt: "asc" }, { id: "asc" }],
        });
        // An order is in at most one open batch: joining this one takes it out of any other.
        await tx.pickBatchOrder.updateMany({
          where: { orderId: { in: ids }, removedAt: null },
          data: { removedAt: now },
        });
        const batch = await tx.pickBatch.create({
          data: {
            ownerId: actor.userId,
            stationId: actor.stationId,
            createdAt: now,
            orders: { create: queued.map((o, index) => ({ orderId: o.id, slot: index + 1 })) },
          },
        });
        await recordAudit(tx, actor, {
          entityType: "PickBatch",
          entityId: batch.id,
          action: "pickBatch.create",
          after: { number: batch.number, orders: queued.map((o) => o.id) },
          at: now,
        });
        return { id: batch.id };
      },
    );

    return readBatch(tx, actor, id, await claimExpiryMinutes(tx), now);
  });
}

/** A batch with its slot legend. Anyone who can read orders can look; acting needs ownership. */
export async function getBatch(
  db: Db,
  actor: Actor,
  { id }: { id: string },
  { now = new Date() }: BatchOptions = {},
): Promise<PickBatch> {
  assertCan(actor, "order.read");
  return db.$transaction(async (tx) => readBatch(tx, actor, id, await claimExpiryMinutes(tx), now));
}

/** **My picks**: the actor's open batch and the other orders they hold a live claim on in Picking. */
export async function myPicks(
  db: Db,
  actor: Actor,
  { now = new Date() }: BatchOptions = {},
): Promise<MyPicks> {
  assertCan(actor, "order.read");
  if (actor.userId === null) throw forbidden();
  const userId = actor.userId;

  return db.$transaction(async (tx) => {
    const expiry = await claimExpiryMinutes(tx);
    const open = await tx.pickBatch.findFirst({
      where: { ownerId: userId, closedAt: null },
      select: { id: true },
    });
    const batch = open ? await readBatch(tx, actor, open.id, expiry, now) : null;
    const inBatch = new Set(
      batch?.closedAt === null
        ? batch.members.filter((m) => m.state === "live").map((m) => m.orderId)
        : [],
    );

    const orders = await tx.order.findMany({
      where: {
        status: "PICKING",
        claimedById: userId,
        claimedAt: { gt: new Date(now.getTime() - expiry * 60_000) },
      },
      select: { id: true, number: true, customerName: true, priority: true, claimedAt: true },
      orderBy: [{ priority: "desc" }, { orderedAt: "asc" }, { id: "asc" }],
    });
    return {
      batch: batch?.closedAt === null ? batch : null,
      orders: orders
        .filter((o) => !inBatch.has(o.id))
        .map((o) => ({ ...o, claimedAt: o.claimedAt as Date })),
    };
  });
}
