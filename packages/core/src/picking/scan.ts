import type { PickLineResult, ScanInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { AppError } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { codesForLine, normalizeCode } from "./codes";
import {
  activeQuantity,
  isWorkLine,
  type LineRow,
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
      const matching = pickOrder(
        rows
          .filter((row) => isWorkLine(row) && codesForLine(row).has(wanted))
          .map((row) => ({ ...row, binLocation: binOf(row) })),
      );
      if (matching.length === 0) throw await notOnOrder(tx, wanted);
      const target = matching.find(
        (row) => row.pickStatus === "PENDING" && row.pickedQuantity < activeQuantity(row),
      );
      if (!target) {
        throw new AppError("CONFLICT", "errors.picking.scanAlreadyPicked", undefined, {
          params: { line: (matching[0] as LineRow).name },
        });
      }
      await writeLineIn(
        tx,
        actor,
        target.id,
        "scan",
        (row, at) => {
          const picked = row.pickedQuantity + 1;
          return {
            pickStatus: picked === activeQuantity(row) ? "PICKED" : "PENDING",
            pickedQuantity: picked,
            pickedById: actor.userId,
            pickedAt: at,
          };
        },
        now,
      );
      return { itemId: target.id };
    });
    const row = await tx.orderItem.findUniqueOrThrow({
      where: { id: itemId },
      include: lineInclude,
    });
    return lineResult(tx, orderId, row);
  });
}

/** The refusal for a code no line of the order has: naming the product it belongs to, if any. */
async function notOnOrder(tx: DbTx, code: string): Promise<AppError> {
  // Codes are stored as the store typed them; compare normalized, as on the lines.
  const [known] = await tx.$queryRaw<{ name: string }[]>`
    SELECT name FROM (
      SELECT v.name, 1 AS rank FROM product_variations v
        WHERE upper(trim(v.barcode)) = ${code} OR upper(trim(v.sku)) = ${code}
      UNION ALL
      SELECT p.name, 2 AS rank FROM products p
        WHERE upper(trim(p.barcode)) = ${code} OR upper(trim(p.sku)) = ${code}
    ) AS found ORDER BY rank, name LIMIT 1`;
  return known
    ? new AppError("CONFLICT", "errors.picking.scanNotOnOrder", undefined, {
        params: { name: known.name },
      })
    : new AppError("CONFLICT", "errors.picking.scanUnknown");
}
