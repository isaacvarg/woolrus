import type {
  LotIdInput,
  PackResult,
  QaLotIdInput,
  QaReplaceLotInput,
  QaResult,
  ScanLotInput,
  SetLotQuantityInput,
} from "@woolrus/contracts";
import type { Db, DbTx, WorkflowStatus } from "@woolrus/db";
import type { LumexiaClient } from "../adapters/lumexia/client";
import { isLumexiaError } from "../adapters/lumexia/errors";
import { recordAudit } from "../audit";
import { AppError, type LineCandidate, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { createTextNote } from "../notes/service";
import { type PackOptions, packResult } from "../packing/queries";
import { lockPackage } from "../packing/service";
import { type Actor, assertCan, type Permission } from "../permissions";
import { qaResult } from "../qa/queries";
import { lockForQa } from "../qa/verify";
import { loadSettings } from "../settings/service";
import { touchClaim } from "../workflow/claims";
import { notifyOrderChanged } from "../workflow/notify";
import { type LotCode, parseLotCode } from "./codes";
import { lumexiaClientFor } from "./connection";
import { loadLots, lotOrder, lotSnapshot, writeLots } from "./lot-store";
import { needsLot } from "./needs-lot";
import { type LotSlot, removeLotFrom, replaceLotIn, scanLotInto, setLotQuantityIn } from "./split";

// Lot capture at Packing (SPEC-lumexia "Capturing lots"). Each write runs like a packing write:
// `order.pack`, the order row lock, Packing, the live claim, audit and notify. Lots don't change
// rates, weights or QA's verification, so nothing is invalidated.

const SCAN = "lumexia.scanLot";
const QA_REPLACE = "lumexia.qaReplaceLot";
/** A rejected scan's note has its own key, so a retried scan doesn't write a second one. */
const REJECTED = "lumexia.scanLotRejected";
/** Someone is waiting at the bench: a QR scan asks Lumexia for at most this long. */
const QR_TIMEOUT_MS = 2_000;

type Connect = (db: Db) => Promise<LumexiaClient | null>;
const defaultConnect: Connect = (d) => lumexiaClientFor(d, { timeoutMs: QR_TIMEOUT_MS });

export type LotOptions = PackOptions & {
  /** The Lumexia client a QR scan asks; tests pass a fake. */
  connect?: Connect;
};

/** The package's box lines with what picking a lot's line needs: the product's link and the lots. */
const boxLines = (tx: DbTx, packageId: string) =>
  tx.packageItem.findMany({
    where: { packageId },
    orderBy: { packedAt: "asc" },
    include: {
      lots: { orderBy: lotOrder },
      orderItem: {
        select: {
          name: true,
          product: {
            select: {
              physical: true,
              lumexiaItemId: true,
              lumexiaItemRef: true,
              lumexiaItemTypeId: true,
              lumexiaProcurementTypeId: true,
              lumexiaInventoryTypeId: true,
              lotOverride: true,
            },
          },
        },
      },
    },
  });

/** A lot number for another item: known offline from its reference code (decision 5). */
class WrongItem {
  constructor(
    readonly orderId: string,
    readonly lotNumber: string,
    readonly itemRef: string,
    readonly products: string[],
  ) {}
}

const wrongItemError = (lotNumber: string, itemRef: string) =>
  new AppError("CONFLICT", "errors.lumexia.lotWrongItem", undefined, {
    params: { lotNumber, itemRef },
  });

/**
 * What a scan names. A printed number names its item by reference code. A QR code names a lot
 * Lumexia may resolve (then `itemId` is its item); unresolved, it's only `lumexiaLotId`.
 */
type ScannedLot = {
  lotNumber: string | null;
  lumexiaLotId: string | null;
  referenceCode: string | null;
  itemId: string | null;
};

/**
 * A QR code's lot, from Lumexia within the 2 s budget. Down, slow, unconfigured or not knowing the
 * lot all leave it unresolved: it's saved `UNVERIFIED` and validated later (decision 5).
 */
async function resolveLot(db: Db, code: LotCode, connect: Connect): Promise<ScannedLot> {
  if (code.kind === "number") {
    return {
      lotNumber: code.lotNumber,
      lumexiaLotId: null,
      referenceCode: code.referenceCode,
      itemId: null,
    };
  }
  const unresolved = { lotNumber: null, lumexiaLotId: code.id, referenceCode: null, itemId: null };
  let found: Awaited<ReturnType<LumexiaClient["getLot"]>>;
  try {
    const client = await connect(db);
    found = client ? await client.getLot(code.id) : null;
  } catch (error) {
    // A key that can't be decrypted is as good as unconfigured here.
    if (isLumexiaError(error) || error instanceof AppError) return unresolved;
    throw error;
  }
  if (!found) return unresolved;
  const lotNumber = found.lotNumber.trim().toUpperCase();
  const parsed = parseLotCode(lotNumber);
  return {
    lotNumber,
    lumexiaLotId: code.id,
    referenceCode: parsed?.kind === "number" ? parsed.referenceCode : null,
    itemId: found.itemId,
  };
}

type BoxLine = Awaited<ReturnType<typeof boxLines>>[number];

/**
 * The lot-needing box lines a lot can go on: its item's (from Lumexia) for a resolved QR code;
 * for a number, the lines with its reference code, else those whose link has no reference code
 * (validation checks them later); for an unresolved QR code, all of them.
 */
type LinkedLine = {
  orderItem: { product: { lumexiaItemId: string | null; lumexiaItemRef: string | null } | null };
};

function candidatesFor<L extends LinkedLine>(lines: L[], lot: ScannedLot): L[] {
  if (lot.itemId) return lines.filter((it) => it.orderItem.product?.lumexiaItemId === lot.itemId);
  if (!lot.referenceCode) return lines;
  const itemRef = (it: L) => it.orderItem.product?.lumexiaItemRef?.toUpperCase() ?? null;
  const exact = lines.filter((it) => itemRef(it) === lot.referenceCode);
  return exact.length > 0 ? exact : lines.filter((it) => itemRef(it) === null);
}

const asCandidate = (it: BoxLine): LineCandidate => ({
  packageItemId: it.id,
  name: it.orderItem.name,
  quantity: it.quantity,
});

/**
 * Scans a lot (its printed number, or its label's QR code) into the package's lot-needing box line
 * for that lot's item, by the split rule. When several lines could take it, refuses with
 * `chooseLine` and the candidates; the client retries with `packageItemId`. A lot for another item
 * is refused with nothing saved on the line, and one internal note on the package written in its
 * own transaction, so it outlives the refused scan. Idempotent on `scanId`. Lots are saved
 * `UNVERIFIED`; validation against Lumexia comes later.
 */
export async function scanLot(
  db: Db,
  actor: Actor,
  { packageId, code, scanId, packageItemId }: ScanLotInput,
  { now = new Date(), connect = defaultConnect }: LotOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  const parsed = parseLotCode(code);
  if (!parsed) throw new AppError("BAD_REQUEST", "errors.lumexia.notALot");
  // Asked before the transaction: the order lock isn't held while Lumexia answers.
  const lot = await resolveLot(db, parsed, connect);

  try {
    return await db.$transaction(async (tx) => {
      const ref = await tx.package.findUnique({
        where: { id: packageId },
        select: { orderId: true },
      });
      if (!ref) throw notFound();
      // A replay is answered before the checks, which may no longer pass (the order moved on).
      if (await storedResult(tx, scanId, SCAN, actor)) return packResult(tx, ref.orderId);

      const { order } = await lockPackage(tx, actor, packageId, now);
      const settings = await loadSettings(tx);
      const lotLines = (await boxLines(tx, packageId)).filter(
        (it) => it.orderItem.product && needsLot(it.orderItem.product, settings),
      );
      if (lotLines.length === 0) throw new AppError("CONFLICT", "errors.lumexia.lotNotOnPackage");
      const candidates = candidatesFor(lotLines, lot);
      if (candidates.length === 0 && lot.lotNumber) {
        throw new WrongItem(
          order.id,
          lot.lotNumber,
          lot.referenceCode ?? lot.lotNumber,
          lotLines.map((it) => it.orderItem.name),
        );
      }
      const target = packageItemId
        ? candidates.find((it) => it.id === packageItemId)
        : candidates[0];
      if (!target) throw new AppError("CONFLICT", "errors.lumexia.lotNotOnPackage");
      if (!packageItemId && candidates.length > 1) {
        throw new AppError("CONFLICT", "errors.lumexia.chooseLine", undefined, {
          candidates: candidates.map(asCandidate),
        });
      }

      let written = false;
      await withIdempotency(tx, scanId, SCAN, actor, async () => {
        const plan = scanLotInto(target.lots, target.quantity, {
          lotNumber: lot.lotNumber,
          lumexiaLotId: lot.lumexiaLotId,
        });
        if (!plan.ok) {
          throw new AppError("CONFLICT", "errors.lumexia.allUnitsHaveLots", undefined, {
            params: { count: target.quantity },
          });
        }
        await writeLots(tx, target.id, target.lots, plan.lots, {
          scannedById: actor.userId,
          now,
        });
        await recordAudit(tx, actor, {
          entityType: "PackageItem",
          entityId: target.id,
          action: "lot.scan",
          before: { lots: lotSnapshot(target.lots) },
          after: {
            lotNumber: lot.lotNumber,
            lumexiaLotId: lot.lumexiaLotId,
            lots: lotSnapshot(plan.lots),
          },
          at: now,
        });
        written = true;
        return { packageItemId: target.id };
      });
      // The same scan, sent twice at once: the first one wrote it, this one only answers.
      if (written) {
        await touchClaim(tx, actor, order.id, { now });
        await notifyOrderChanged(tx, { id: order.id, status: order.status });
      }
      return packResult(tx, order.id);
    });
  } catch (error) {
    if (!(error instanceof WrongItem)) throw error;
    await noteRejectedLot(db, actor, packageId, scanId, error);
    throw wrongItemError(error.lotNumber, error.itemRef);
  }
}

/**
 * Changes one lot's count by hand (the chip's dialog). The default lot gives or takes the
 * difference and keeps at least 1, so the lots still cover the box line: `errors.lumexia.lotQuantity`
 * with the allowed `{ min, max }` otherwise. The default's own count is whatever the others leave.
 */
export function setLotQuantity(
  db: Db,
  actor: Actor,
  { lotId, quantity }: SetLotQuantityInput,
  options: PackOptions = {},
): Promise<PackResult> {
  return editLot(db, actor, packing, lotId, "lot.setQuantity", options, (lots) => {
    const plan = setLotQuantityIn(lots, lotId, quantity);
    if (!plan.ok) {
      throw new AppError("CONFLICT", "errors.lumexia.lotQuantity", undefined, {
        params: { min: plan.min, max: plan.max },
      });
    }
    return plan.lots;
  });
}

/**
 * Removes a lot from its box line: its units go to the default lot. Removing the default makes
 * the next lot by position the default; removing the only lot leaves the line needing a lot.
 */
export function removeLot(
  db: Db,
  actor: Actor,
  { lotId }: LotIdInput,
  options: PackOptions = {},
): Promise<PackResult> {
  return editLot(db, actor, packing, lotId, "lot.remove", options, (lots) =>
    removeLotFrom(lots, lotId),
  );
}

/**
 * QA removes a lot (SPEC-lumexia "QA fixes"), as at Packing: its units go to the default lot. How
 * a `WRONG_ITEM` block is cleared without sending the order back to Packing.
 */
export function qaRemoveLot(
  db: Db,
  actor: Actor,
  { lotId }: QaLotIdInput,
  options: PackOptions = {},
): Promise<QaResult> {
  return editLot(db, actor, qa, lotId, "lot.qaRemove", options, (lots) =>
    removeLotFrom(lots, lotId),
  );
}

/** Where a lot is edited: who may, the lock that proves the order is theirs there, and the answer. */
type Stage<R> = {
  permission: Permission;
  lock: (
    tx: DbTx,
    actor: Actor,
    pkg: { id: string; orderId: string },
    now: Date,
  ) => Promise<{ id: string; status: WorkflowStatus }>;
  result: (tx: DbTx, orderId: string) => Promise<R>;
};

const packing: Stage<PackResult> = {
  permission: "order.pack",
  lock: async (tx, actor, pkg, now) => (await lockPackage(tx, actor, pkg.id, now)).order,
  result: packResult,
};

const qa: Stage<QaResult> = {
  permission: "order.qa",
  lock: async (tx, actor, pkg, now) => {
    const order = await lockForQa(tx, actor, pkg.orderId, now);
    // Read after the lock: a repack may have just discarded it.
    const row = await tx.package.findUnique({
      where: { id: pkg.id },
      select: { discardedAt: true },
    });
    if (!row || row.discardedAt) throw notFound();
    // Labels are being bought for what QA saw; nothing on the order changes under them.
    const buying = await tx.shippingLabel.count({
      where: { package: { orderId: pkg.orderId }, status: "PURCHASING" },
    });
    if (buying > 0) throw new AppError("CONFLICT", "errors.qa.purchaseInProgress");
    return order;
  },
  result: (tx, orderId) => qaResult(tx, orderId),
};

/** A hand edit of one box line's lots, run like a write of its stage. An edit that changes nothing writes nothing. */
async function editLot<R>(
  db: Db,
  actor: Actor,
  stage: Stage<R>,
  lotId: string,
  action: string,
  { now = new Date() }: PackOptions,
  plan: (lots: LotSlot[]) => LotSlot[],
): Promise<R> {
  assertCan(actor, stage.permission);
  return db.$transaction(async (tx) => {
    const row = await tx.packageItemLot.findUnique({
      where: { id: lotId },
      select: {
        packageItem: {
          select: { id: true, packageId: true, package: { select: { orderId: true } } },
        },
      },
    });
    if (!row) throw notFound();
    const { id: packageItemId, packageId, package: pkg } = row.packageItem;
    const order = await stage.lock(tx, actor, { id: packageId, orderId: pkg.orderId }, now);
    // Read again under the lock: another write may have just changed or removed it.
    const before = await loadLots(tx, packageItemId);
    if (!before.some((l) => l.id === lotId)) throw notFound();
    const after = plan(before);
    const unchanged =
      after.length === before.length &&
      after.every((l) => before.some((b) => b.id === l.id && b.quantity === l.quantity));
    if (!unchanged) {
      await writeLots(tx, packageItemId, before, after, { scannedById: actor.userId, now });
      await recordAudit(tx, actor, {
        entityType: "PackageItem",
        entityId: packageItemId,
        action,
        before: { lots: lotSnapshot(before) },
        after: { lotId, lots: lotSnapshot(after) },
        at: now,
      });
      await touchClaim(tx, actor, order.id, { now });
      await notifyOrderChanged(tx, { id: order.id, status: order.status });
    }
    return stage.result(tx, order.id);
  });
}

/**
 * QA replaces a lot (SPEC-lumexia "QA fixes"): the scanned lot goes on the same box line with the
 * old lot's units, and the old row goes. The same item check as at Packing: a lot number for
 * another item is refused with nothing changed and one internal note on the package. A QR code
 * Lumexia can't resolve now is taken, unverified, as at Packing. Idempotent on `scanId`.
 */
export async function qaReplaceLot(
  db: Db,
  actor: Actor,
  { lotId, code, scanId }: QaReplaceLotInput,
  { now = new Date(), connect = defaultConnect }: LotOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  const parsed = parseLotCode(code);
  if (!parsed) throw new AppError("BAD_REQUEST", "errors.lumexia.notALot");
  const lot = await resolveLot(db, parsed, connect);

  let packageId: string | null = null;
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.packageItemLot.findUnique({
        where: { id: lotId },
        select: {
          packageItem: {
            select: {
              id: true,
              packageId: true,
              package: { select: { orderId: true } },
              orderItem: {
                select: {
                  name: true,
                  product: { select: { lumexiaItemId: true, lumexiaItemRef: true } },
                },
              },
            },
          },
        },
      });
      // A replay is answered before the checks, which may no longer pass (the lot is gone).
      const replay = await storedResult<{ orderId: string }>(tx, scanId, QA_REPLACE, actor);
      if (replay) return qaResult(tx, replay.orderId);
      if (!row) throw notFound();
      const line = row.packageItem;
      packageId = line.packageId;
      const order = await qa.lock(
        tx,
        actor,
        { id: line.packageId, orderId: line.package.orderId },
        now,
      );
      const before = await loadLots(tx, line.id);
      if (!before.some((l) => l.id === lotId)) throw notFound();
      if (candidatesFor([line], lot).length === 0 && lot.lotNumber) {
        throw new WrongItem(order.id, lot.lotNumber, lot.referenceCode ?? lot.lotNumber, [
          line.orderItem.name,
        ]);
      }

      await withIdempotency(tx, scanId, QA_REPLACE, actor, async () => {
        const after = replaceLotIn(before, lotId, {
          lotNumber: lot.lotNumber,
          lumexiaLotId: lot.lumexiaLotId,
        });
        await writeLots(tx, line.id, before, after, { scannedById: actor.userId, now });
        await recordAudit(tx, actor, {
          entityType: "PackageItem",
          entityId: line.id,
          action: "lot.qaReplace",
          before: { lots: lotSnapshot(before) },
          after: {
            lotId,
            lotNumber: lot.lotNumber,
            lumexiaLotId: lot.lumexiaLotId,
            lots: lotSnapshot(after),
          },
          at: now,
        });
        await touchClaim(tx, actor, order.id, { now });
        await notifyOrderChanged(tx, { id: order.id, status: order.status });
        return { orderId: order.id };
      });
      return qaResult(tx, order.id);
    });
  } catch (error) {
    if (!(error instanceof WrongItem) || !packageId) throw error;
    await noteRejectedLot(db, actor, packageId, scanId, error);
    throw wrongItemError(error.lotNumber, error.itemRef);
  }
}

/**
 * The internal note on the package for a lot scanned against the wrong item. Its own transaction,
 * after the scan's rolled back; once per scan, so a retry or a duplicate in flight adds none.
 */
async function noteRejectedLot(
  db: Db,
  actor: Actor,
  packageId: string,
  scanId: string,
  rejected: WrongItem,
): Promise<void> {
  const content =
    `Lot ${rejected.lotNumber} (item ${rejected.itemRef}) was scanned for ` +
    `${rejected.products.join(", ")} and rejected: it belongs to a different item.`;
  try {
    await db.$transaction(async (tx) => {
      await withIdempotency(tx, `${REJECTED}:${scanId}`, REJECTED, actor, async () => {
        await createTextNote(tx, actor, { orderId: rejected.orderId, packageId, content });
        return { packageId };
      });
      const order = await tx.order.findUniqueOrThrow({
        where: { id: rejected.orderId },
        select: { id: true, status: true },
      });
      await notifyOrderChanged(tx, order);
    });
  } catch (error) {
    // The same scan, sent twice at once, lost the race for the note's key: the other wrote it.
    if ((error as { code?: string }).code === "P2002") return;
    throw error;
  }
}
