import { PgBoss } from "pg-boss";
import { JOBS_SCHEMA, queues } from "./jobs";

/**
 * Creates (or upgrades) pg-boss's tables and this app's queues, then disconnects. `enqueue` from
 * web needs them; the worker creates them when it starts, and this does it without a worker, for
 * CI and tests (`pnpm jobs:install`). Idempotent.
 */
export async function installJobs(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema: JOBS_SCHEMA,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  try {
    for (const name of Object.values(queues)) await boss.createQueue(name);
  } finally {
    await boss.stop({ graceful: false });
  }
}
