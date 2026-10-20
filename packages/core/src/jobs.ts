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
};

/** pg-boss keeps its tables in their own schema, separate from Prisma's. */
export const JOBS_SCHEMA = "pgboss";
