import type { DbTx, WorkflowStatus } from "@woolrus/db";

export const ORDER_CHANGED_CHANNEL = "order_changed";

/** Id and status only, never PII: every signed-in subscriber receives it. */
export type OrderChangedEvent = { id: string; status: WorkflowStatus };

/** Postgres delivers the notification when `tx` commits, and drops it if it rolls back. */
export async function notifyOrderChanged(tx: DbTx, event: OrderChangedEvent): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${ORDER_CHANGED_CHANNEL}, ${JSON.stringify(event)})`;
}
