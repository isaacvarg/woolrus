import type { DbTx, Order } from "@woolrus/db";
import { notFound } from "../errors";

/** The workflow columns of an order row held with `FOR UPDATE` until the transaction ends. */
export type LockedOrder = Pick<
  Order,
  "id" | "status" | "version" | "claimedById" | "claimedAt" | "heldFromStatus"
>;

const columns = `id, status::text AS status, version, claimed_by_id AS "claimedById",
  claimed_at AS "claimedAt", held_from_status::text AS "heldFromStatus"`;

export async function lockOrder(tx: DbTx, orderId: string): Promise<LockedOrder> {
  const [row] = await tx.$queryRawUnsafe<LockedOrder[]>(
    `SELECT ${columns} FROM orders WHERE id = $1::uuid FOR UPDATE`,
    orderId,
  );
  if (!row) throw notFound();
  return row;
}

/** Locks rows in id order, so two batches over the same orders can't deadlock. Missing ids are absent. */
export async function lockOrders(tx: DbTx, orderIds: readonly string[]): Promise<LockedOrder[]> {
  return tx.$queryRawUnsafe<LockedOrder[]>(
    `SELECT ${columns} FROM orders WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [...orderIds],
  );
}
