import type { LotDto } from "@woolrus/contracts";
import type { DbTx, PackageItemLot } from "@woolrus/db";
import { enqueue } from "../enqueue";
import { queues } from "../jobs";
import { addUnitsToLots, type LotSlot, removeUnitsFromLots } from "./split";

// Reading and writing a box line's lots (SPEC-lumexia "Capturing lots"). Every caller holds the
// order row lock, which is what keeps Σ lots ≤ the box line's quantity: there's no SQL check for it.

export const lotOrder = { position: "asc" } as const;

export const loadLots = (tx: DbTx, packageItemId: string) =>
  tx.packageItemLot.findMany({ where: { packageItemId }, orderBy: lotOrder });

/** The default lot is the earliest; rows come ordered by position. */
export function toLotDtos(rows: readonly PackageItemLot[]): LotDto[] {
  return rows.map((row, i) => ({
    id: row.id,
    lotNumber: row.lotNumber,
    lumexiaLotId: row.lumexiaLotId,
    quantity: row.quantity,
    status: row.status,
    isDefault: i === 0,
  }));
}

/** What an audit event records about a box line's lots. */
export const lotSnapshot = (lots: readonly LotSlot[]) =>
  lots.map((l) => ({
    lotNumber: l.lotNumber,
    lumexiaLotId: l.lumexiaLotId,
    quantity: l.quantity,
    position: l.position,
  }));

/**
 * Writes `after` over `before`: changed quantities, new lots (saved `UNVERIFIED`), and lots that
 * went. Deletes run first, so a unique lot number can't collide with a row about to go. New lots
 * get a `lumexia.validateLots` job on the same transaction (SPEC-lumexia "Validation"); a count
 * changing doesn't change what Lumexia says about a lot, so it queues nothing.
 */
export async function writeLots(
  tx: DbTx,
  packageItemId: string,
  before: readonly LotSlot[],
  after: readonly LotSlot[],
  { scannedById, now }: { scannedById: string | null; now: Date },
): Promise<void> {
  const kept = new Set(after.flatMap((l) => (l.id ? [l.id] : [])));
  const gone = before.flatMap((l) => (l.id && !kept.has(l.id) ? [l.id] : []));
  if (gone.length > 0) await tx.packageItemLot.deleteMany({ where: { id: { in: gone } } });
  const was = new Map(before.map((l) => [l.id, l.quantity]));
  const created: string[] = [];
  for (const lot of after) {
    if (lot.id) {
      if (was.get(lot.id) !== lot.quantity) {
        await tx.packageItemLot.update({ where: { id: lot.id }, data: { quantity: lot.quantity } });
      }
      continue;
    }
    const row = await tx.packageItemLot.create({
      select: { id: true },
      data: {
        packageItemId,
        lotNumber: lot.lotNumber,
        lumexiaLotId: lot.lumexiaLotId,
        quantity: lot.quantity,
        position: lot.position,
        status: "UNVERIFIED",
        scannedById,
        scannedAt: now,
      },
    });
    created.push(row.id);
  }
  if (created.length > 0) {
    await enqueue(tx, queues.lumexiaValidateLots, { packageItemLotIds: created });
  }
}

/** Units packed into a box line that has lots go to its default lot. */
export async function lotsAfterPacking(tx: DbTx, packageItemId: string, units: number) {
  const before = await loadLots(tx, packageItemId);
  if (before.length === 0) return;
  await writeLots(tx, packageItemId, before, addUnitsToLots(before, units), {
    scannedById: null,
    now: new Date(),
  });
}

/** Units taken out of a box line that stays: from the default down to 1, then the latest lot. */
export async function lotsAfterUnpacking(tx: DbTx, packageItemId: string, units: number) {
  const before = await loadLots(tx, packageItemId);
  if (before.length === 0) return;
  await writeLots(tx, packageItemId, before, removeUnitsFromLots(before, units), {
    scannedById: null,
    now: new Date(),
  });
}
