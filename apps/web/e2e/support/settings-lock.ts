import { createDb } from "@woolrus/db";

const db = createDb();
const SETTINGS_LOCK = 4_242_001;

/**
 * Runs `fn` while holding a Postgres advisory lock, so tests in parallel workers (the desktop and
 * tablet projects) that change the same global settings take turns. The lock lives in a transaction
 * that only waits; `fn` drives the browser as usual.
 */
export function withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK})`;
      return fn();
    },
    { maxWait: 60_000, timeout: 120_000 },
  );
}
