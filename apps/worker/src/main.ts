import {
  configuredStore,
  createS3Storage,
  ensureBucketOnFirstUse,
  fakeShippingProviders,
  getEmailSender,
  isFinalAttempt,
  JOBS_SCHEMA,
  type JobPayloads,
  pollIfDue,
  processWooWebhook,
  queueOptions,
  queues,
  recomputePriorities,
  runEmailJob,
  runRatesFetchJob,
  runStorageDeleteJob,
  s3ConfigFromEnv,
  sweepOrphanFiles,
  syncProducts,
} from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { type JobWithMetadata, PgBoss } from "pg-boss";

const log = createLogger({ module: "main" });

// Fake shipping providers quote fake rates and buy fake labels: never what production should run.
if (process.env.NODE_ENV === "production" && fakeShippingProviders()) {
  log.warn("SHIPPING_PROVIDERS=fake is on in production: rates and labels are fake");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = new PgBoss({ connectionString, schema: JOBS_SCHEMA });
boss.on("error", (err) => log.error({ err }, "pg-boss error"));

await boss.start();

// The attachments bucket is created on start, so a fresh install needs no manual step. Storage
// being down mustn't stop order sync: log it, and the first storage job tries again.
const storageLog = createLogger({ module: "storage" });
const storage = ensureBucketOnFirstUse(createS3Storage(s3ConfigFromEnv()));
await storage
  .ensureBucket()
  .then(() => storageLog.info("storage bucket ready"))
  .catch((err: unknown) =>
    storageLog.error({ err }, "storage bucket not ready; retrying on first use"),
  );

for (const name of Object.values(queues)) {
  await boss.createQueue(name, queueOptions[name]);
}

// FR-SYNC-09: tick every minute; `pollIfDue` polls once `syncIntervalMinutes` have passed, so a
// changed interval needs no rescheduling. "Sync now" enqueues a manual job, which always polls.
await boss.schedule(queues.ordersSync, "* * * * *", { reason: "schedule" });

const storeLog = createLogger({ module: "woocommerce" });
const store = () =>
  configuredStore(db, { log: (entry) => storeLog.debug(entry, "woocommerce request") });

await boss.work<JobPayloads[typeof queues.ordersSync]>(queues.ordersSync, async ([job]) => {
  const reason = job?.data.reason ?? "schedule";
  const result = await pollIfDue(db, await store(), { reason });
  if (result.status !== "notDue")
    log.info({ jobId: job?.id, reason, ...result }, "orders.sync done");
});

// FR-SYNC-11: one job per stored delivery; the order is refetched from the store, not the payload.
// A bulk edit in the store sends a burst, so poll often and run a few at once: the per-order
// advisory lock serialises two deliveries for the same order.
await boss.work<JobPayloads[typeof queues.ordersWebhook]>(
  queues.ordersWebhook,
  { pollingIntervalSeconds: 0.5, localConcurrency: 4 },
  async ([job]) => {
    if (!job) return;
    await processWooWebhook(db, await store(), job.data.inboundWebhookId);
    log.info({ jobId: job.id, inboundWebhookId: job.data.inboundWebhookId }, "orders.webhook done");
  },
);

// FR-SYNC-12: the catalog nightly at 03:00 server time, and on "Sync products now".
await boss.schedule(
  queues.productsSync,
  "0 3 * * *",
  { reason: "schedule" },
  { tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
);

await boss.work<JobPayloads[typeof queues.productsSync]>(queues.productsSync, async ([job]) => {
  const result = await syncProducts(db, await store());
  log.info({ jobId: job?.id, reason: job?.data.reason, ...result }, "products.sync done");
});

// Age rules ("older than 2 days") change an order's priority with no event to trigger it.
await boss.schedule(queues.ordersRecomputePriority, "*/5 * * * *", {});

await boss.work<JobPayloads[typeof queues.ordersRecomputePriority]>(
  queues.ordersRecomputePriority,
  async ([job]) => {
    const { updated } = await db.$transaction((tx) => recomputePriorities(tx), {
      timeout: 60_000,
    });
    log.info({ jobId: job?.id, updated }, "orders.recomputePriority done");
  },
);

// App email (SPEC-identity "Email"). Retries (3 attempts, backoff) come from the queue's policy.
const emailLog = createLogger({ module: "email" });
await boss.work<JobPayloads[typeof queues.emailSend]>(queues.emailSend, async ([job]) => {
  if (!job) return;
  const sender = await getEmailSender(db, {
    log: (entry) => emailLog.warn(entry, "email logged, not sent: Resend isn't configured"),
  });
  const result = await runEmailJob(sender, job.data, {
    log: (entry) => emailLog.error(entry, "email refused by Resend; not retrying"),
  });
  log.info({ jobId: job.id, template: job.data.template, result }, "email.send done");
});

// Note files (SPEC-notes "Deleting files"). Deletes come from the note's transaction; retries
// (6 attempts, backoff) come from the queue's policy, and a missing object counts as done.
await boss.work<JobPayloads[typeof queues.storageDelete]>(queues.storageDelete, async ([job]) => {
  if (!job) return;
  const result = await runStorageDeleteJob(storage, job.data);
  storageLog.info({ jobId: job.id, ...result }, "storage.delete done");
});

// The sweep collects files no attachment points to: failed deletes, and notes removed by a cascade
// (a deleted package or line item). Daily at 04:00 server time, after the catalog sync.
await boss.schedule(
  queues.storageSweep,
  "0 4 * * *",
  {},
  { tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
);

await boss.work<JobPayloads[typeof queues.storageSweep]>(queues.storageSweep, async ([job]) => {
  const result = await sweepOrphanFiles(db, storage);
  storageLog.info({ jobId: job?.id, ...result }, "storage.sweep done");
});

// Rates after Packing → QA and on Refresh rates (FR-PACK-07). Every provider failing transiently
// throws for a retry (3 attempts, backoff); the last attempt stores the failure for QA instead.
const ratesLog = createLogger({ module: "rates" });
await boss.work(
  queues.ratesFetch,
  { includeMetadata: true, localConcurrency: 4 },
  async ([job]: JobWithMetadata<JobPayloads[typeof queues.ratesFetch]>[]) => {
    if (!job) return;
    const result = await runRatesFetchJob(db, job.data, { finalAttempt: isFinalAttempt(job) });
    ratesLog.info({ jobId: job.id, ...job.data, ...result }, "rates.fetch done");
  },
);

log.info({ queues: Object.values(queues) }, "worker started");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "worker stopping");
  await boss.stop({ graceful: true, timeout: 30_000 });
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
