import type { Locale } from "@woolrus/i18n";
import type { EmailTemplate } from "./identity/emails";

/**
 * Background job names and payloads, shared by whoever enqueues (web, worker) and the worker
 * that runs them. Jobs live in Postgres (pg-boss), so they can be enqueued in the same
 * transaction as the change that caused them (see `enqueue`).
 */
export const queues = {
  /** Pull new and changed orders from WooCommerce (FR-SYNC-01/09/10). */
  ordersSync: "orders.sync",
  /** Import the order a received WooCommerce webhook names (FR-SYNC-11). */
  ordersWebhook: "orders.webhook",
  /** Refresh the product catalog from WooCommerce (FR-SYNC-12). */
  productsSync: "products.sync",
  /** Re-evaluate priority rules on open orders, so age rules take effect over time (FR-LIST-04). */
  ordersRecomputePriority: "orders.recomputePriority",
  /** Send one app email through the configured sender (SPEC-identity "Email"). */
  emailSend: "email.send",
  /** Delete stored files whose attachment rows are gone (SPEC-notes "Deleting files", FR-NOTE-06). */
  storageDelete: "storage.delete",
  /** Daily: delete `notes/` files no attachment points to, e.g. after a cascade (SPEC-notes). */
  storageSweep: "storage.sweep",
  /** Ask every enabled shipping provider for each package's rates (FR-PACK-07, SPEC-carriers "Rate fetch"). */
  ratesFetch: "rates.fetch",
  /** Buy an order's labels in the background after Complete QA (SPEC-qa "Complete QA"). */
  labelsPurchase: "labels.purchase",
  /** Settle labels left PURCHASING by a lost provider response (SPEC-qa). */
  labelsReconcile: "labels.reconcile",
} as const;
export type QueueName = (typeof queues)[keyof typeof queues];

export type JobPayloads = {
  [queues.ordersSync]: { reason: "schedule" | "manual" };
  [queues.ordersWebhook]: { inboundWebhookId: string };
  [queues.productsSync]: { reason: "schedule" | "manual" };
  [queues.ordersRecomputePriority]: Record<string, never>;
  /** Never a magic-link URL: those are sent inline, so a sign-in link doesn't sit in the job table. */
  [queues.emailSend]: {
    to: string;
    template: EmailTemplate;
    params: Record<string, string>;
    locale: Locale;
    idempotencyKey: string;
  };
  /** Object keys (files and thumbnails); missing ones count as deleted. */
  [queues.storageDelete]: { keys: string[] };
  [queues.storageSweep]: Record<string, never>;
  /** `generation` is the order's `rateGeneration` when enqueued; a job for an older one writes nothing. */
  [queues.ratesFetch]: { orderId: string; generation: number };
  [queues.labelsPurchase]: { orderId: string };
  [queues.labelsReconcile]: Record<string, never>;
};

/**
 * Per-queue retry policy, set when the queue is created; every job sent to it inherits it.
 * Queues not listed keep pg-boss's defaults.
 */
export const queueOptions: Partial<
  Record<QueueName, { retryLimit: number; retryDelay: number; retryBackoff: boolean }>
> = {
  // 3 attempts: a 429 or 5xx from Resend throws and is retried after ~30 s, then ~60 s. The
  // idempotency key makes a retry after a lost response harmless.
  [queues.emailSend]: { retryLimit: 2, retryDelay: 30, retryBackoff: true },
  // Storage down for a while shouldn't lose a delete: 6 attempts over roughly half an hour. A job
  // that still fails leaves orphans, which the daily sweep collects.
  [queues.storageDelete]: { retryLimit: 5, retryDelay: 60, retryBackoff: true },
  // Only a fetch where every provider failed transiently throws; a partial one is QA's to refresh.
  [queues.ratesFetch]: { retryLimit: 2, retryDelay: 20, retryBackoff: true },
};

/** pg-boss keeps its tables in their own schema, separate from Prisma's. */
export const JOBS_SCHEMA = "pgboss";

/**
 * Whether a pg-boss job is on its last try: `retryCount` counts the retries so far, so with
 * `retryLimit: 2` the third run (`retryCount` 2) is the last. A handler that stores a failure for
 * people to see does it then rather than on every attempt.
 */
export function isFinalAttempt(job: { retryCount: number; retryLimit: number }): boolean {
  return job.retryCount >= job.retryLimit;
}
