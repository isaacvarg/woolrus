import type { Db, ScanMissKind, ScanMissStage } from "@woolrus/db";
import { logger } from "@woolrus/logger";
import type { AppError } from "../errors";
import type { Actor } from "../permissions";

// Blocked scans (SPEC-order-activity "Blocked scans"): a refused scan rolls back, so the miss is
// written after it, in its own transaction, and the same error is rethrown.

export type ScanMiss = {
  kind: ScanMissKind;
  orderId: string;
  productName?: string | null;
  orderItemId?: string | null;
  packageId?: string | null;
  batchId?: string | null;
};

export type ScanMisses = {
  /** Marks `error` as a refusal about the item scanned; returns it to throw. */
  refuse(error: AppError, miss: ScanMiss): AppError;
  /** The same for a `notOnOrder` refusal: an unknown code, or a known product not on the order. */
  notOnOrder(error: AppError, miss: Omit<ScanMiss, "kind" | "productName">): AppError;
  /**
   * Awaits the scan's transaction. When it fails with an error marked by `refuse`, writes that
   * miss and rethrows the error unchanged; any other error (claim lost, purchase in progress)
   * records nothing. A retried scan with the same `scanId` writes no second row.
   */
  settle<T>(scan: Promise<T>): Promise<T>;
};

export function scanMisses(
  db: Db,
  actor: Actor,
  scan: { stage: ScanMissStage; code: string; scanId: string },
): ScanMisses {
  let pending: { error: AppError; miss: ScanMiss } | undefined;
  const refuse = (error: AppError, miss: ScanMiss) => {
    pending = { error, miss };
    return error;
  };
  return {
    refuse,
    notOnOrder(error, miss) {
      const name = error.params?.name;
      return error.messageKey === "errors.picking.scanUnknown"
        ? refuse(error, { ...miss, kind: "UNKNOWN_CODE" })
        : refuse(error, {
            ...miss,
            kind: "NOT_ON_ORDER",
            productName: typeof name === "string" ? name : null,
          });
    },
    async settle(run) {
      try {
        return await run;
      } catch (error) {
        if (pending && error === pending.error) await write(db, actor, scan, pending.miss);
        throw error;
      }
    },
  };
}

async function write(
  db: Db,
  actor: Actor,
  { stage, code, scanId }: { stage: ScanMissStage; code: string; scanId: string },
  miss: ScanMiss,
) {
  try {
    await db.scanMiss.createMany({
      data: [{ ...miss, stage, code, scanId, actorId: actor.userId, stationId: actor.stationId }],
      skipDuplicates: true,
    });
  } catch (cause) {
    // The person scanning sees the refusal as before, even if the record of it fails.
    logger.warn({ err: cause, stage, orderId: miss.orderId }, "scan miss not recorded");
  }
}
