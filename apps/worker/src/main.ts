import {
  configuredStore,
  JOBS_SCHEMA,
  type JobPayloads,
  pollIfDue,
  processWooWebhook,
  queues,
  recomputePriorities,
} from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { PgBoss } from "pg-boss";

const log = createLogger({ module: "main" });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = new PgBoss({ connectionString, schema: JOBS_SCHEMA });
boss.on("error", (err) => log.error({ err }, "pg-boss error"));

await boss.start();

for (const name of Object.values(queues)) {
  await boss.createQueue(name);
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
await boss.work<JobPayloads[typeof queues.ordersWebhook]>(queues.ordersWebhook, async ([job]) => {
  if (!job) return;
  await processWooWebhook(db, await store(), job.data.inboundWebhookId);
  log.info({ jobId: job.id, inboundWebhookId: job.data.inboundWebhookId }, "orders.webhook done");
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
