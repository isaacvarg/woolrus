import type { LotChoices, LotChoicesInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import type { LumexiaClient } from "../adapters/lumexia/client";
import { isLumexiaError } from "../adapters/lumexia/errors";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { lumexiaClientFor } from "./connection";

// The pack screen's lot picker: tapping **Lot needed** lists the line's Lumexia lots, newest
// first, as another way in besides scanning the label. Choosing one is a `scanLot` of its number
// on that box line, so the split rule, the item check and the audit are the scan's own.

/** The newest lots are the likely ones; an item with years of lots doesn't need them all. */
export const LOT_CHOICES_MAX = 50;

type Connect = (db: Db) => Promise<LumexiaClient | null>;

/** A box line's Lumexia lots, newest first. Reading only: no claim needed, nothing written. */
export async function lotChoices(
  db: Db,
  actor: Actor,
  { packageId, orderItemId }: LotChoicesInput,
  { connect = lumexiaClientFor }: { connect?: Connect } = {},
): Promise<LotChoices> {
  assertCan(actor, "order.pack");
  const line = await db.packageItem.findUnique({
    where: { packageId_orderItemId: { packageId, orderItemId } },
    select: { id: true, orderItem: { select: { product: { select: { lumexiaItemId: true } } } } },
  });
  if (!line) throw notFound();
  const itemId = line.orderItem.product?.lumexiaItemId ?? null;
  const answer = (status: LotChoices["status"], lots: LotChoices["lots"] = []): LotChoices => ({
    packageItemId: line.id,
    status,
    lots,
  });
  if (!itemId) return answer("notLinked");

  let lots: Awaited<ReturnType<LumexiaClient["listItemLots"]>>;
  try {
    const client = await connect(db);
    if (!client) return answer("unconfigured");
    lots = await client.listItemLots(itemId);
  } catch (error) {
    // A key that can't be decrypted is as good as Lumexia being unreachable here.
    if (isLumexiaError(error) || error instanceof AppError) return answer("unavailable");
    throw error;
  }
  const newest = lots
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, LOT_CHOICES_MAX);
  return answer(
    "ok",
    newest.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber.trim().toUpperCase(),
      createdAt: l.createdAt,
    })),
  );
}
