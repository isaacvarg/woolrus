import { type JobPayloads, queues, recomputePriorities } from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { PgBoss } from "pg-boss";

const log = createLogger({ module: "main" });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// pg-boss keeps its tables in their own schema, separate from Prisma's.
const boss = new PgBoss({ connectionString, schema: "pgboss" });
boss.on("error", (err) => log.error({ err }, "pg-boss error"));

await boss.start();

for (const name of Object.values(queues)) {
  await boss.createQueue(name);
}

// FR-SYNC-09: poll WooCommerce on a schedule; webhooks (FR-SYNC-11) enqueue the same job.
await boss.schedule(queues.ordersSync, "*/5 * * * *", { reason: "schedule" });

await boss.work<JobPayloads[typeof queues.ordersSync]>(queues.ordersSync, async ([job]) => {
  // Placeholder until the WooCommerce adapter lands.
  log.info({ jobId: job?.id, reason: job?.data.reason }, "orders.sync: not implemented yet");
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
