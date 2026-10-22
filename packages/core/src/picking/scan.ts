import type { PickLineResult, ScanInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { AppError } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan, can } from "../permissions";
import { codesForLine, normalizeCode } from "./codes";
import { findCodeOwner } from "./link-barcode";
import {
  activeQuantity,
  isWorkLine,
  type LineRow,
  type LineWrite,
  lineInclude,
  lineResult,
  lockForPicking,
  type PickOptions,
  writeLineIn,
} from "./service";
import { pickOrder } from "./sort";

// Scan to confirm (SPEC-picking "Code matching", FR-PICK-06): one scanned code is one unit on the
// first matching line that still needs it. A refused scan throws, so it changes and audits nothing.

const binOf = (row: LineRow) => row.variation?.binLocation ?? row.product?.binLocation ?? null;

/** Adds one unit to the order's first unfinished line that the code matches. Idempotent on `scanId`. */
export async function scan(
  db: Db,
  actor: Actor,
  { orderId, code, scanId }: ScanInput,
  { now = new Date() }: PickOptions = {},
): Promise<PickLineResult> {
  assertCan(actor, "order.pick");
  const wanted = normalizeCode(code);
  return db.$transaction(async (tx) => {
    await lockForPicking(tx, actor, orderId, now);
    // Only the line id is stored: a replay answers with the line as it is now.
    const { itemId } = await withIdempotency(tx, scanId, "picking.scan", actor, async () => {
      const rows = await tx.orderItem.findMany({ where: { orderId }, include: lineInclude });
      const matching = matchingLines(rows, wanted);
      if (matching.length === 0) {
        throw await notOnOrder(tx, wanted, can(actor, "product.manage"));
      }
      const target = matching.find(needsUnit);
      if (!target) throw alreadyPicked(matching);
      await writeLineIn(tx, actor, target.id, "scan", addUnit(actor), now);
      return { itemId: target.id };
    });
    const row = await tx.orderItem.findUniqueOrThrow({
      where: { id: itemId },
      include: lineInclude,
    });
    return lineResult(tx, orderId, row);
  });
}

/** The work lines the code matches, in pick order. */
export function matchingLines(rows: LineRow[], wanted: string): LineRow[] {
  return pickOrder(
    rows
      .filter((row) => isWorkLine(row) && codesForLine(row).has(wanted))
      .map((row) => ({ ...row, binLocation: binOf(row) })),
  );
}

/** A line a scanned unit can go on. */
export const needsUnit = (row: LineRow) =>
  row.pickStatus === "PENDING" && row.pickedQuantity < activeQuantity(row);

/** The write for one scanned unit: picked once the last one is in. */
export const addUnit =
  (actor: Actor) =>
  (row: LineRow, at: Date): LineWrite => {
    const picked = row.pickedQuantity + 1;
    return {
      pickStatus: picked === activeQuantity(row) ? "PICKED" : "PENDING",
      pickedQuantity: picked,
      pickedById: actor.userId,
      pickedAt: at,
    };
  };

/** The refusal when every line the code matches is done, naming the first. */
export const alreadyPicked = (matching: LineRow[]) =>
  new AppError("CONFLICT", "errors.picking.scanAlreadyPicked", undefined, {
    params: { line: (matching[0] as LineRow).name },
  });

/**
 * The refusal for a code no line of the order (or batch) has: naming the product it belongs to, if
 * any, else offering `canLink` to callers who may link it.
 */
export async function notOnOrder(
  tx: DbTx,
  code: string,
  canLink: boolean,
  notOnKey: ErrorCode = "errors.picking.scanNotOnOrder",
): Promise<AppError> {
  const known = await findCodeOwner(tx, code);
  return known
    ? new AppError("CONFLICT", notOnKey, undefined, {
        params: { name: known.name },
      })
    : new AppError("CONFLICT", "errors.picking.scanUnknown", undefined, canLink ? { canLink } : {});
}
