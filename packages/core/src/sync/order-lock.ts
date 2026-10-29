import type { DbTx } from "@woolrus/db";

/** First argument of the two-key advisory lock taken per WooCommerce order id. */
const ORDER_LOCK_NAMESPACE = 4_201_002;

/**
 * Serializes work on one store order for the rest of the transaction: the import and the PII
 * anonymizer both take it, so an import can't write personal data back over an anonymized order.
 */
export async function lockWooOrder(tx: DbTx, wooOrderId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_LOCK_NAMESPACE}::int, ${wooOrderId}::int)`;
}
