/**
 * Background job names and payloads, shared by whoever enqueues (web, worker) and the worker
 * that runs them. Jobs live in Postgres (pg-boss), so they can be enqueued in the same
 * transaction as the change that caused them.
 */
export const queues = {
  /** Pull new and changed orders from WooCommerce (FR-SYNC-01/09/10). */
  ordersSync: "orders.sync",
} as const;
export type QueueName = (typeof queues)[keyof typeof queues];

export type JobPayloads = {
  [queues.ordersSync]: { reason: "schedule" | "manual" | "webhook" };
};
