import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Db } from "@woolrus/db";

// The worker heartbeat (SPEC-operations "Worker heartbeat"). A job, not a timer, writes it: that
// proves the worker is consuming the queue, not just alive.

const WORKER = "worker";

/** The worker is stale once its last beat is older than this (3 minutes). */
export const WORKER_STALE_MS = 3 * 60_000;

/** The file the worker container's `HEALTHCHECK` watches the age of. */
export const HEARTBEAT_FILE = "/tmp/worker-heartbeat";

export type WorkerHealth = "ok" | "stale";

/** Upserts the `worker` row and touches the heartbeat file. */
export async function recordWorkerHeartbeat(
  db: Db,
  opts: { version?: string | null; now?: Date; file?: string } = {},
): Promise<void> {
  const beatAt = opts.now ?? new Date();
  const version = opts.version ?? null;
  await db.serviceHeartbeat.upsert({
    where: { name: WORKER },
    create: { name: WORKER, beatAt, version },
    update: { beatAt, version },
  });
  const file = opts.file ?? HEARTBEAT_FILE;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "", { flag: "a" });
  await utimes(file, beatAt, beatAt);
}

/** The `worker` health entry: `stale` when the last beat is over 3 minutes old, or there is none. */
export async function workerHealth(db: Db, now: Date = new Date()): Promise<WorkerHealth> {
  const row = await db.serviceHeartbeat.findUnique({ where: { name: WORKER } });
  return row && now.getTime() - row.beatAt.getTime() <= WORKER_STALE_MS ? "ok" : "stale";
}
