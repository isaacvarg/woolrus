import type { PackResult, ScanLotInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { createTextNote } from "../notes/service";
import { type PackOptions, packResult } from "../packing/queries";
import { lockPackage } from "../packing/service";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { touchClaim } from "../workflow/claims";
import { notifyOrderChanged } from "../workflow/notify";
import { parseLotCode } from "./codes";
import { lotOrder, lotSnapshot, writeLots } from "./lot-store";
import { needsLot } from "./needs-lot";
import { scanLotInto } from "./split";

// Lot capture at Packing (SPEC-lumexia "Capturing lots"). Each write runs like a packing write:
// `order.pack`, the order row lock, Packing, the live claim, audit and notify. Lots don't change
// rates, weights or QA's verification, so nothing is invalidated.

const SCAN = "lumexia.scanLot";
/** A rejected scan's note has its own key, so a retried scan doesn't write a second one. */
const REJECTED = "lumexia.scanLotRejected";

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
 * Scans a printed lot number into the package's lot-needing box line for that lot's item, by the
 * split rule. A lot for another item is refused with nothing saved on the line, and one internal
 * note on the package written in its own transaction, so it outlives the refused scan. Idempotent
 * on `scanId`. Lots are saved `UNVERIFIED`; validation against Lumexia comes later.
 */
export async function scanLot(
  db: Db,
  actor: Actor,
  { packageId, code, scanId }: ScanLotInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  const lot = parseLotCode(code);
  if (!lot) throw new AppError("BAD_REQUEST", "errors.lumexia.notALot");
  // QR codes (the lot's UUID) need Lumexia to name their item; they come with the QR ticket.
  if (lot.kind === "uuid") throw new AppError("BAD_REQUEST", "errors.lumexia.scanLotNumber");

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
      // A line whose link has no reference code can't be checked offline; validation will.
      const candidates = lotLines.filter((it) => {
        const itemRef = it.orderItem.product?.lumexiaItemRef;
        return !itemRef || itemRef.toUpperCase() === lot.referenceCode;
      });
      const target = candidates[0];
      if (!target) {
        throw new WrongItem(
          order.id,
          lot.lotNumber,
          lot.referenceCode,
          lotLines.map((it) => it.orderItem.name),
        );
      }

      let written = false;
      await withIdempotency(tx, scanId, SCAN, actor, async () => {
        const plan = scanLotInto(target.lots, target.quantity, {
          lotNumber: lot.lotNumber,
          lumexiaLotId: null,
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
          after: { lotNumber: lot.lotNumber, lots: lotSnapshot(plan.lots) },
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
