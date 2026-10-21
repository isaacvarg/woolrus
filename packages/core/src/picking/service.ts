import type { PickLine, PickLineInput, PickLineResult, PickView } from "@woolrus/contracts";
import type { Db, DbTx, PickStatus, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { lineAndPackageNoteCounts } from "../notes/targets";
import { type Actor, assertCan } from "../permissions";
import { claimExpiryMinutes, holdsClaim, isClaimLive, touchClaim } from "../workflow/claims";
import { toOrderDetails } from "../workflow/detail";
import { evaluateGate, loadGateSnapshot } from "../workflow/gates";
import { type LockedOrder, lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { displayName, nameFields } from "../workflow/people";
import { toAttributes } from "../workflow/queries";
import { pickOrder } from "./sort";

// Line picks (SPEC-picking "Pick rules"). Only the claim holder writes an order's lines, and the
// order row lock orders those writes against transitions. So pick writes don't bump Order.version:
// a burst of optimistic taps would otherwise make the picker's own completePicking fail as stale.

export type PickOptions = { now?: Date };

export const lineInclude = {
  product: { select: { physical: true, binLocation: true, barcode: true, sku: true } },
  variation: { select: { binLocation: true, barcode: true, sku: true } },
  voids: { where: { undoneAt: null }, select: { quantity: true } },
  pickedBy: { select: nameFields },
} as const satisfies Prisma.OrderItemInclude;

export type LineRow = Prisma.OrderItemGetPayload<{ include: typeof lineInclude }>;

export const activeQuantity = (row: LineRow) =>
  Math.max(row.quantity - row.voids.reduce((sum, v) => sum + v.quantity, 0), 0);

// A line whose product row is gone counts as physical (SPEC-workflow "Schema additions").
export const isWorkLine = (row: LineRow) =>
  (row.product?.physical ?? true) && activeQuantity(row) > 0;

const isDone = (status: PickStatus) => status === "PICKED" || status === "SUBSTITUTED";

function toPickLine(row: LineRow, noteCount: number): PickLine {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    imageUrl: row.imageUrl,
    attributes: toAttributes(row.attributes),
    binLocation: row.variation?.binLocation ?? row.product?.binLocation ?? null,
    quantity: activeQuantity(row),
    pickedQuantity: row.pickedQuantity,
    pickStatus: row.pickStatus,
    substitutionNote: row.substitutionNote,
    pickedBy: row.pickedBy ? { name: displayName(row.pickedBy) } : null,
    pickedAt: row.pickedAt,
    noteCount,
  };
}

async function progress(tx: DbTx, orderId: string): Promise<{ done: number; total: number }> {
  const work = (await tx.orderItem.findMany({ where: { orderId }, include: lineInclude })).filter(
    isWorkLine,
  );
  return { done: work.filter((l) => isDone(l.pickStatus)).length, total: work.length };
}

export type LineWrite = Pick<
  Prisma.OrderItemUncheckedUpdateInput,
  "pickStatus" | "pickedQuantity" | "pickedById" | "pickedAt" | "substitutionNote"
>;

/** Locks the order and checks it is in Picking under the actor's live claim. Run inside a transaction. */
export async function lockForPicking(
  tx: DbTx,
  actor: Actor,
  orderId: string,
  now: Date,
): Promise<LockedOrder> {
  // Settings before the order lock: the lock order workflow uses everywhere.
  const expiry = await claimExpiryMinutes(tx);
  const order = await lockOrder(tx, orderId);
  if (order.status !== "PICKING") throw new AppError("CONFLICT", "errors.picking.notPicking");
  if (!isClaimLive(order, expiry, now) || !holdsClaim(actor, order.claimedById)) {
    throw new AppError("CONFLICT", "errors.picking.claimRequired");
  }
  return order;
}

/**
 * Runs one line write: permission, the order lock, the Picking + live-claim checks, then the write,
 * its audit, the claim refresh and the order_changed notify, all in one transaction.
 */
async function writeLine(
  db: Db,
  actor: Actor,
  itemId: string,
  op: string,
  decide: (row: LineRow, now: Date) => LineWrite,
  { now = new Date() }: PickOptions,
): Promise<PickLineResult> {
  assertCan(actor, "order.pick");
  return db.$transaction((tx) => writeLineIn(tx, actor, itemId, op, decide, now));
}

/** `writeLine` inside the caller's transaction, for operations that pick the line themselves (scan). */
export async function writeLineIn(
  tx: DbTx,
  actor: Actor,
  itemId: string,
  op: string,
  decide: (row: LineRow, now: Date) => LineWrite,
  now: Date,
): Promise<PickLineResult> {
  assertCan(actor, "order.pick");
  const ref = await tx.orderItem.findUnique({ where: { id: itemId }, select: { orderId: true } });
  if (!ref) throw notFound();
  const order = await lockForPicking(tx, actor, ref.orderId, now);

  // Read after the lock, so a store edit to the line can't slip in between.
  const row = await tx.orderItem.findUniqueOrThrow({
    where: { id: itemId },
    include: lineInclude,
  });
  if (!isWorkLine(row)) throw new AppError("CONFLICT", "errors.picking.lineNotPickable");

  const data = decide(row, now);
  const updated = await tx.orderItem.update({
    where: { id: itemId },
    data,
    include: lineInclude,
  });

  await recordAudit(tx, actor, {
    entityType: "OrderItem",
    entityId: itemId,
    action: `pick.${op}`,
    before: { pickStatus: row.pickStatus, pickedQuantity: row.pickedQuantity },
    after: { pickStatus: updated.pickStatus, pickedQuantity: updated.pickedQuantity },
    at: now,
  });
  await touchClaim(tx, actor, order.id, { now });
  await notifyOrderChanged(tx, { id: order.id, status: order.status });
  return lineResult(tx, order.id, updated);
}

/** A line as the pick screen shows it, with the order's done/total counts. */
export async function lineResult(tx: DbTx, orderId: string, row: LineRow): Promise<PickLineResult> {
  const notes = await lineAndPackageNoteCounts(tx, orderId);
  return {
    line: toPickLine(row, notes.items.get(row.id) ?? 0),
    ...(await progress(tx, orderId)),
  };
}

/** Picks the whole line, or records `quantity` units so far (FR-PICK-02). Replaces Out of Stock or Substituted. */
export function pickLine(
  db: Db,
  actor: Actor,
  { itemId, quantity }: PickLineInput,
  options: PickOptions = {},
): Promise<PickLineResult> {
  return writeLine(
    db,
    actor,
    itemId,
    "pickLine",
    (row, now) => {
      const active = activeQuantity(row);
      const picked = quantity ?? active;
      if (picked > active) {
        throw new AppError("BAD_REQUEST", "errors.validation", { quantity: "errors.field.tooBig" });
      }
      return {
        pickStatus: picked === active ? "PICKED" : "PENDING",
        pickedQuantity: picked,
        pickedById: actor.userId,
        pickedAt: now,
        substitutionNote: null,
      };
    },
    options,
  );
}

/** Puts the line back to not picked, forgetting who picked it and any substitution. */
export function unpickLine(
  db: Db,
  actor: Actor,
  { itemId }: { itemId: string },
  options: PickOptions = {},
): Promise<PickLineResult> {
  return writeLine(
    db,
    actor,
    itemId,
    "unpickLine",
    () => ({
      pickStatus: "PENDING",
      pickedQuantity: 0,
      pickedById: null,
      pickedAt: null,
      substitutionNote: null,
    }),
    options,
  );
}

/** The pick screen for one order (SPEC-picking "Reads"). */
export async function getPickView(
  db: DbTx,
  actor: Actor,
  { orderId }: { orderId: string },
  { now = new Date() }: PickOptions = {},
): Promise<PickView> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: { include: lineInclude } },
  });
  if (!order) throw notFound();

  const [[detail], notes, snapshot] = await Promise.all([
    toOrderDetails(db, [order], { now }),
    lineAndPackageNoteCounts(db, orderId),
    loadGateSnapshot(db, orderId),
  ]);
  if (!detail) throw notFound();

  const physical = order.items.filter((row) => row.product?.physical ?? true);
  const work = physical.filter(isWorkLine);
  const lines = pickOrder(work.map((row) => toPickLine(row, notes.items.get(row.id) ?? 0)));
  return {
    order: detail,
    customerNote: order.customerNote,
    lines,
    voidedLines: physical.length - work.length,
    done: lines.filter((l) => isDone(l.pickStatus)).length,
    total: lines.length,
    unmet: evaluateGate("picked", snapshot),
  };
}
