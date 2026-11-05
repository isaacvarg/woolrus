import { createDb } from "@woolrus/db";

const db = createDb();
const SETTINGS_LOCK = 4_242_001;

/**
 * Far longer than any test (the longest sets 240 s) plus its wait for the lock, so the transaction
 * never ends under a running `fn`: it only frees the lock if `fn` hangs past every test timeout.
 */
const HOLD_MS = 30 * 60_000;

/**
 * Runs `fn` while holding a Postgres advisory lock, so tests in parallel workers (the desktop and
 * tablet projects) that change the same global settings take turns. `fn` drives the browser as
 * usual and uses its own connections.
 *
 * The lock is transaction-scoped and lives in an interactive transaction, which Prisma pins to one
 * pooled connection until it ends: the lock is taken and released on the same connection, and it
 * can't outlive `fn` on a connection that goes back to the pool (as a session lock could). The
 * transaction's timeout counts the wait for the lock too, hence `HOLD_MS` rather than the test's
 * own timeout. Interactive transactions only: `pg` isn't a dependency of the web app.
 */
export function withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK})`;
      return fn();
    },
    { maxWait: 60_000, timeout: HOLD_MS },
  );
}
