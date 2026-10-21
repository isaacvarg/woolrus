import type {
  MarkOutOfStockInput,
  PickLine,
  PickLineInput,
  PickLineResult,
  PickView,
  SubstituteInput,
} from "@woolrus/contracts";
import type { Db, DbTx, PickStatus, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { createTextNote } from "../notes/service";
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

/** For the writes that also add a line note: run once per key, and the note's text. */
type WithNote = { idempotencyKey: string; note: (row: LineRow) => string };

/**
 * Runs one line write: permission, the order lock, the Picking + live-claim checks, then the write,
 * its audit, an optional line note, the claim refresh and the order_changed notify, all in one
 * transaction. With a note the write runs once per `idempotencyKey`; a replay returns the line as
 * it is now.
 */
async function writeLine(
  db: Db,
  actor: Actor,
  itemId: string,
  op: string,
  decide: (row: LineRow, now: Date) => LineWrite,
  { now = new Date() }: PickOptions,
  withNote?: WithNote,
): Promise<PickLineResult> {
  assertCan(actor, "order.pick");
  return db.$transaction(async (tx) => {
    if (!withNote) return writeLineIn(tx, actor, itemId, op, decide, now);
    await withIdempotency(tx, withNote.idempotencyKey, `picking.${op}`, actor, async () => {
      await writeLineIn(tx, actor, itemId, op, decide, now, withNote.note);
      return {};
    });
    const line = await tx.orderItem.findUniqueOrThrow({
      where: { id: itemId },
      include: lineInclude,
    });
    return lineResult(tx, line.orderId, line);
  });
}

/** `writeLine` inside the caller's transaction, for operations that pick the line themselves (scan). */
export async function writeLineIn(
  tx: DbTx,
  actor: Actor,
  itemId: string,
  op: string,
  decide: (row: LineRow, now: Date) => LineWrite,
  now: Date,
  note?: (row: LineRow) => string,
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
  if (note) {
    await createTextNote(tx, actor, { orderId: order.id, orderItemId: itemId, content: note(row) });
  }

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

const tooBig = (field: string) =>
  new AppError("BAD_REQUEST", "errors.validation", { [field]: "errors.field.tooBig" });

/**
 * The line isn't on the shelf: records how many were found (fewer than needed) and why, as an
 * internal line note. Blocks the picked gate until the line is voided, substituted or picked.
 */
export function markOutOfStock(
  db: Db,
  actor: Actor,
  { itemId, foundQuantity, note, idempotencyKey }: MarkOutOfStockInput,
  options: PickOptions = {},
): Promise<PickLineResult> {
  return writeLine(
    db,
    actor,
    itemId,
    "markOutOfStock",
    (row, now) => {
      if (foundQuantity >= activeQuantity(row)) throw tooBig("foundQuantity");
      return {
        pickStatus: "OUT_OF_STOCK",
        pickedQuantity: foundQuantity,
        pickedById: actor.userId,
        pickedAt: now,
        substitutionNote: null,
      };
    },
    options,
    { idempotencyKey, note: () => note },
  );
}

/** Something else went in instead: the line counts as picked, and the swap is noted on it. */
export function substitute(
  db: Db,
  actor: Actor,
  { itemId, substitute: instead, note, idempotencyKey }: SubstituteInput,
  options: PickOptions = {},
): Promise<PickLineResult> {
  const text = instead.trim();
  if (text.length === 0) {
    throw new AppError("BAD_REQUEST", "errors.validation", { substitute: "errors.field.required" });
  }
  if (text.length > 200) throw tooBig("substitute");
  const extra = note?.trim();
  return writeLine(
    db,
    actor,
    itemId,
    "substitute",
    (row, now) => ({
      pickStatus: "SUBSTITUTED",
      pickedQuantity: activeQuantity(row),
      pickedById: actor.userId,
      pickedAt: now,
      substitutionNote: text,
    }),
    options,
    {
      idempotencyKey,
      note: () => (extra ? `Substituted: ${text}\n${extra}` : `Substituted: ${text}`),
    },
  );
}

/**
 * Recomputes a line's pick state after its active quantity changed (a void or an unvoid). The
 * contract with `exceptions`, which calls it in the same transaction and checks its own
 * permission, so there's no claim check here.
 */
export async function reconcilePick(tx: DbTx, itemId: string): Promise<void> {
  const row = await tx.orderItem.findUniqueOrThrow({ where: { id: itemId }, include: lineInclude });
  const active = activeQuantity(row);
  const pickedQuantity =
    row.pickStatus === "SUBSTITUTED" ? active : Math.min(row.pickedQuantity, active);
  let pickStatus = row.pickStatus;
  // The missing units were voided: what was found is all that's needed.
  if (pickStatus === "OUT_OF_STOCK" && pickedQuantity === active) pickStatus = "PICKED";
  // A void was undone: the line needs more units again.
  if (pickStatus === "PICKED" && pickedQuantity < active) pickStatus = "PENDING";
  if (pickStatus === row.pickStatus && pickedQuantity === row.pickedQuantity) return;
  await tx.orderItem.update({ where: { id: itemId }, data: { pickStatus, pickedQuantity } });
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
