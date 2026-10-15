/**
 * Background job names and payloads, shared by whoever enqueues (web, worker) and the worker
 * that runs them. Jobs live in Postgres (pg-boss), so they can be enqueued in the same
 * transaction as the change that caused them.
 */
export const queues = {
  /** Pull new and changed orders from WooCommerce (FR-SYNC-01/09/10). */
  ordersSync: "orders.sync",
  /** Re-evaluate priority rules on open orders, so age rules take effect over time (FR-LIST-04). */
  ordersRecomputePriority: "orders.recomputePriority",
} as const;
export type QueueName = (typeof queues)[keyof typeof queues];

export type JobPayloads = {
  [queues.ordersSync]: { reason: "schedule" | "manual" | "webhook" };
  [queues.ordersRecomputePriority]: Record<string, never>;
};
