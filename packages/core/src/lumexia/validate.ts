import type { Db, DbTx, LotStatus } from "@woolrus/db";
import type { LumexiaClient, LumexiaLot } from "../adapters/lumexia/client";
import { LumexiaAuthError } from "../adapters/lumexia/errors";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { JOBS_SCHEMA, type JobPayloads, queues } from "../jobs";
import { createTextNote } from "../notes/service";
import { lumexiaActor } from "../permissions";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { type LumexiaHealth, lumexiaClientFor, lumexiaHealth } from "./connection";

// Lot validation (SPEC-lumexia "Validation"). Lots are saved UNVERIFIED at Packing and checked here,
// in the background, so Lumexia being slow or down never holds up the floor (decision 5). Every lot
// write enqueues `lumexia.validateLots` on its own transaction; a sweep picks up the rest.

/** The sweep leaves a just-saved lot to the job its write enqueued. */
const UNVERIFIED_GRACE_MS = 5 * 60_000;
/** A NOT_FOUND lot is re-checked once a day (it may be created in Lumexia later)… */
const NOT_FOUND_RECHECK_MS = 24 * 60 * 60_000;
/** …for a week after it was scanned, then left as it is. */
const NOT_FOUND_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
/** Lots per job the sweep queues. */
const SWEEP_BATCH = 200;
/** Lots one sweep queues at most; the rest wait for the next sweep. */
const SWEEP_LIMIT = 2_000;

/** Settled lots aren't checked again: a wrong lot is fixed by replacing it, not by re-checking. */
const settled: readonly LotStatus[] = ["VALID", "WRONG_ITEM"];

type Connect = (db: Db) => Promise<LumexiaClient | null>;
const defaultConnect: Connect = (d) => lumexiaClientFor(d);

export type ValidateLotsResult = {
  valid: number;
  notFound: number;
  wrongItem: number;
  /** Gone, already settled, or on a line whose product isn't linked. */
  skipped: number;
};

const lotWithLine = (tx: DbTx | Db, id: string) =>
  tx.packageItemLot.findUnique({
    where: { id },
    include: {
      packageItem: {
        select: {
          id: true,
          packageId: true,
          package: { select: { orderId: true } },
          orderItem: { select: { name: true, product: { select: { lumexiaItemId: true } } } },
        },
      },
    },
  });

/** What Lumexia knows of a lot: by its id when the QR code gave one, else by its number. */
async function lookUp(
  client: LumexiaClient,
  lot: { lotNumber: string | null; lumexiaLotId: string | null },
): Promise<LumexiaLot[]> {
  if (lot.lumexiaLotId) {
    const found = await client.getLot(lot.lumexiaLotId);
    if (found) return [found];
  }
  return lot.lotNumber ? client.findLotsByNumber(lot.lotNumber) : [];
}

/**
 * Checks each lot against Lumexia: on the line's item → `VALID`, filling in a missing number or id;
 * only on other items → `WRONG_ITEM` and an internal note on the package; nowhere → `NOT_FOUND`.
 * Each check sets `checkedAt`, is audited as the `lumexia` actor and notifies the order. Lumexia's
 * errors are thrown as they are, so the job retries; lots checked before the error keep their result.
 * Runs whatever the order's status: a late `WRONG_ITEM` adds the note and undoes nothing.
 */
export async function validateLots(
  db: Db,
  client: LumexiaClient,
  packageItemLotIds: readonly string[],
  { now = new Date() }: { now?: Date } = {},
): Promise<ValidateLotsResult> {
  const result: ValidateLotsResult = { valid: 0, notFound: 0, wrongItem: 0, skipped: 0 };
  for (const id of new Set(packageItemLotIds)) {
    const first = await lotWithLine(db, id);
    const itemId = first?.packageItem.orderItem.product?.lumexiaItemId;
    if (!first || !itemId || settled.includes(first.status)) {
      result.skipped += 1;
      continue;
    }
    // Asked before the transaction: the order lock isn't held while Lumexia answers.
    const found = await lookUp(client, first);
    const onItem = found.find((l) => l.itemId === itemId);
    const other = found.find((l) => l.itemId !== itemId);
    // The other item's reference code, for the note.
    const otherRef =
      !onItem && other ? ((await client.getItem(other.itemId))?.referenceCode ?? null) : null;

    const status = await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, first.packageItem.package.orderId);
      // Read again under the lock: a packer may have changed or removed it meanwhile.
      const lot = await lotWithLine(tx, id);
      if (!lot || settled.includes(lot.status)) return null;
      const status: LotStatus = onItem ? "VALID" : other ? "WRONG_ITEM" : "NOT_FOUND";
      const after = onItem
        ? await settleValid(tx, lot, onItem, now)
        : await tx.packageItemLot.update({ where: { id }, data: { status, checkedAt: now } });
      if (status === "WRONG_ITEM") {
        const lotNumber = after.lotNumber ?? other?.lotNumber ?? lot.lumexiaLotId ?? "";
        await createTextNote(tx, lumexiaActor, {
          orderId: order.id,
          packageId: lot.packageItem.packageId,
          content:
            `Lot ${lotNumber} (item ${otherRef ?? "unknown"}) was scanned for ` +
            `${lot.packageItem.orderItem.name}, but it belongs to a different item.`,
        });
      }
      await recordAudit(tx, lumexiaActor, {
        entityType: "PackageItem",
        entityId: lot.packageItem.id,
        action: "lot.validate",
        before: {
          lotId: id,
          status: lot.status,
          lotNumber: lot.lotNumber,
          lumexiaLotId: lot.lumexiaLotId,
        },
        after: {
          lotId: id,
          status,
          lotNumber: after.lotNumber,
          lumexiaLotId: after.lumexiaLotId,
          ...(after.id !== id && { mergedInto: after.id, quantity: after.quantity }),
          by: lumexiaActor.system,
        },
        at: now,
      });
      await notifyOrderChanged(tx, { id: order.id, status: order.status });
      return status;
    });

    if (status === "VALID") result.valid += 1;
    else if (status === "WRONG_ITEM") result.wrongItem += 1;
    else if (status === "NOT_FOUND") result.notFound += 1;
    else result.skipped += 1;
  }
  return result;
}

/**
 * Marks a lot VALID with both its number and its Lumexia id. When the same lot is already on the
 * line under its other identifier (its number scanned, and its QR code scanned while Lumexia was
 * down), the two rows are one lot: this row's units fold into that one, which keeps the earlier
 * position, so lot lookup finds every unit by either identifier. Returns the row that remains.
 */
async function settleValid(
  tx: DbTx,
  lot: { id: string; packageItemId: string; quantity: number; position: number },
  found: LumexiaLot,
  now: Date,
) {
  const identity = { lotNumber: found.lotNumber.trim().toUpperCase(), lumexiaLotId: found.id };
  const twin = await tx.packageItemLot.findFirst({
    where: {
      packageItemId: lot.packageItemId,
      id: { not: lot.id },
      OR: [{ lotNumber: identity.lotNumber }, { lumexiaLotId: identity.lumexiaLotId }],
    },
  });
  if (!twin) {
    return tx.packageItemLot.update({
      where: { id: lot.id },
      data: { status: "VALID", checkedAt: now, ...identity },
    });
  }
  // Deleted first, so the twin can take both identifiers without tripping the unique keys.
  await tx.packageItemLot.delete({ where: { id: lot.id } });
  return tx.packageItemLot.update({
    where: { id: twin.id },
    data: {
      status: "VALID",
      checkedAt: now,
      ...identity,
      quantity: twin.quantity + lot.quantity,
      position: Math.min(twin.position, lot.position),
    },
  });
}

/**
 * The `lumexia.validateLots` job. Skipped while Lumexia isn't configured: the lots stay UNVERIFIED
 * and the sweep queues them again. A refused key ends the job's retries, so it fails at once and
 * shows on the failed-jobs page; an outage throws for pg-boss to retry.
 */
export async function runValidateLotsJob(
  db: Db,
  { packageItemLotIds }: JobPayloads[typeof queues.lumexiaValidateLots],
  { connect = defaultConnect, jobId, now }: { connect?: Connect; jobId?: string; now?: Date } = {},
): Promise<ValidateLotsResult | { skipped: "unconfigured" }> {
  const client = await connect(db);
  if (!client) return { skipped: "unconfigured" };
  try {
    return await validateLots(db, client, packageItemLotIds, { now });
  } catch (error) {
    if (error instanceof LumexiaAuthError && jobId) {
      await endRetries(db, queues.lumexiaValidateLots, jobId);
    }
    throw error;
  }
}

/**
 * Makes the running attempt a job's last: pg-boss fails a job for good once `retry_count` reaches
 * `retry_limit`, so the throw that follows lands it in `failed` instead of `retry`.
 */
async function endRetries(db: Db, queue: string, jobId: string): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE ${JOBS_SCHEMA}.job SET retry_limit = retry_count WHERE name = $1 AND id = $2::uuid`,
    queue,
    jobId,
  );
}

/**
 * The 10-minute `lumexia.sweepLots` job: queues validation for UNVERIFIED lots older than 5 minutes
 * (saved while Lumexia was down or unconfigured, or whose job ran out of retries) and for NOT_FOUND
 * lots last checked a day ago or more, for 7 days after they were scanned. Lines whose product isn't
 * linked are left out: there's no item to check them against.
 *
 * It queues nothing while Lumexia isn't healthy (unconfigured, down, or refusing the key), so an
 * outage or a bad key doesn't pile up failed jobs every 10 minutes; lots already waiting in a
 * validation job aren't queued again, so a slow Lumexia doesn't get each lot checked twice; and one
 * sweep queues at most `SWEEP_LIMIT` lots, oldest first, leaving the rest to the next.
 */
export async function sweepLots(
  db: Db,
  {
    now = new Date(),
    health = () => lumexiaHealth(db),
  }: { now?: Date; health?: () => Promise<LumexiaHealth> } = {},
): Promise<{ queued: number } | { queued: 0; skipped: Exclude<LumexiaHealth, "ok"> }> {
  const state = await health();
  if (state !== "ok") return { queued: 0, skipped: state };
  const at = (ms: number) => new Date(now.getTime() - ms);
  const waiting = await queuedLotIds(db);
  const due = await db.packageItemLot.findMany({
    where: {
      id: { notIn: waiting },
      packageItem: { orderItem: { product: { lumexiaItemId: { not: null } } } },
      OR: [
        { status: "UNVERIFIED", scannedAt: { lte: at(UNVERIFIED_GRACE_MS) } },
        {
          status: "NOT_FOUND",
          scannedAt: { gt: at(NOT_FOUND_GIVE_UP_MS) },
          OR: [{ checkedAt: null }, { checkedAt: { lte: at(NOT_FOUND_RECHECK_MS) } }],
        },
      ],
    },
    orderBy: { scannedAt: "asc" },
    take: SWEEP_LIMIT,
    select: { id: true },
  });
  const ids = due.map((l) => l.id);
  if (ids.length === 0) return { queued: 0 };
  await db.$transaction(async (tx) => {
    for (let i = 0; i < ids.length; i += SWEEP_BATCH) {
      await enqueue(tx, queues.lumexiaValidateLots, {
        packageItemLotIds: ids.slice(i, i + SWEEP_BATCH),
      });
    }
  });
  return { queued: ids.length };
}

/** Lots in a validation job that hasn't finished: waiting, retrying or running. */
async function queuedLotIds(db: Db): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT DISTINCT jsonb_array_elements_text(data->'packageItemLotIds') AS id
       FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
    queues.lumexiaValidateLots,
  );
  return rows.map((r) => r.id);
}
