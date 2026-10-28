import type { DbTx } from "@woolrus/db";
import { PgBoss } from "pg-boss";
import { JOBS_SCHEMA, type JobPayloads, type QueueName } from "./jobs";

/**
 * Enqueues a job on the caller's transaction: the job exists only if `tx` commits, so a webhook
 * stored and a job to process it, or a manual "Sync now" and its audit row, can't come apart.
 *
 * pg-boss runs here on a Prisma-backed adapter and is never started: `send` with an adapter just
 * inserts the job row (checked against the dev stack in T6). The worker owns the queues and runs jobs.
 */
export async function enqueue<Q extends QueueName>(
  tx: DbTx,
  queue: Q,
  payload: JobPayloads[Q],
  options: { singletonKey?: string } = {},
): Promise<string | null> {
  const { boss, db } = bossOn(tx);
  return boss.send(queue, payload, { ...options, db });
}

/**
 * A never-started pg-boss whose statements run on `tx`. Built per call: its queue lookups go
 * through `tx` too, and it holds no connections or timers. Pass `db` as the call's option.
 */
export function bossOn(tx: DbTx) {
  const db = {
    executeSql: async (text: string, values: unknown[] = []) => ({
      rows: await tx.$queryRawUnsafe<unknown[]>(text, ...values),
    }),
  };
  return { boss: new PgBoss({ db, schema: JOBS_SCHEMA }), db };
}
