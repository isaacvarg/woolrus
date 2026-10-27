import type { OrderShipping, ShipToActionInput } from "@woolrus/contracts";
import { type Db, type DbTx, Prisma, type WorkflowStatus } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import { getOrderShipping, lockRerate, refetch } from "./rates";

// QA's address actions (SPEC-carriers "Ship-to and address validation"). Both change what rates
// use, so both drop the old rates and fetch again.

/** The ship-to fields a fresh resolution starts from: nothing stored, nothing checked. */
const cleared = {
  shipTo: Prisma.DbNull,
  shipToOriginal: Prisma.DbNull,
  shipToStatus: "UNCHECKED",
  shipToMessages: [],
  shipToCheckedAt: null,
} as const satisfies Prisma.OrderUpdateInput;

/** Ships to the address as the customer gave it, unchecked, and re-rates. Audited. */
export async function keepOriginalAddress(
  db: Db,
  actor: Actor,
  { orderId }: ShipToActionInput,
): Promise<OrderShipping> {
  assertCan(actor, "order.qa");
  await db.$transaction(async (tx) => {
    const order = await lockRerate(tx, orderId);
    const { shipTo, shipToOriginal, shipToStatus } = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { shipTo: true, shipToOriginal: true, shipToStatus: true },
    });
    if (shipToOriginal === null) throw new AppError("CONFLICT", "errors.carriers.noShipTo");
    await tx.order.update({
      where: { id: orderId },
      data: {
        shipTo: shipToOriginal,
        shipToStatus: "UNCHECKED",
        shipToMessages: [],
        shipToCheckedAt: null,
      },
    });
    const generation = await refetch(tx, orderId, { dropRates: true });
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "shipTo.useOriginal",
      before: { shipTo, shipToStatus } as Prisma.InputJsonObject,
      after: { shipTo: shipToOriginal, generation } as Prisma.InputJsonObject,
    });
    await notifyOrderChanged(tx, { id: orderId, status: order.status });
  });
  return getOrderShipping(db, actor, { orderId });
}

/** Resolves and checks the address again on the next fetch, and starts it. Audited. */
export async function recheckAddress(
  db: Db,
  actor: Actor,
  { orderId }: ShipToActionInput,
): Promise<OrderShipping> {
  assertCan(actor, "order.qa");
  await db.$transaction(async (tx) => {
    const order = await lockRerate(tx, orderId);
    // The original stays on show until the fetch resolves it again.
    const { shipToOriginal: _, ...recheck } = cleared;
    await tx.order.update({ where: { id: orderId }, data: recheck });
    const generation = await refetch(tx, orderId, { dropRates: true });
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "shipTo.recheck",
      after: { generation },
    });
    await notifyOrderChanged(tx, { id: orderId, status: order.status });
  });
  return getOrderShipping(db, actor, { orderId });
}

/**
 * The store changed the order's addresses: what was resolved and checked no longer holds. An order
 * in QA fetches its rates again; elsewhere the next fetch resolves it. The caller holds the order
 * lock and notifies.
 */
export async function forgetShipTo(
  tx: DbTx,
  order: { id: string; status: WorkflowStatus },
): Promise<void> {
  await tx.order.update({ where: { id: order.id }, data: cleared });
  if (order.status === "QA") await refetch(tx, order.id, { dropRates: true });
}
