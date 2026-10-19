import type { Db } from "@woolrus/db";

// One run of each kind at a time (FR-SYNC-09): the worker's schedule, a manual run and the CLI never
// overlap. Webhook imports don't take this lock; the per-order lock in orders.ts covers them.

export type SyncLockName = "orders" | "products";

/** Advisory lock keys (unique among the app's advisory locks, see priority-rules.ts). */
const LOCK_KEYS: Record<SyncLockName, number> = { orders: 4_201_003, products: 4_201_004 };

/** A run longer than this loses the lock (Prisma ends the holding transaction). */
const MAX_HOLD_MS = 60 * 60 * 1000;

export type SyncLockResult<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Runs `fn` if no one else holds `name`'s lock, else returns `{ acquired: false }` at once.
 *
 * Prisma pools connections, so a session lock could be released on a different connection than it
 * was taken on. Instead, one transaction holds `pg_try_advisory_xact_lock` until `fn` settles; `fn`
 * runs on other connections. If the process dies, the connection drops and the lock goes with it.
 */
export async function withSyncLock<T>(
  db: Db,
  name: SyncLockName,
  fn: () => Promise<T>,
): Promise<SyncLockResult<T>> {
  let signal: (locked: boolean) => void = () => {};
  const locked = new Promise<boolean>((resolve) => {
    signal = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const holder = db.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEYS[name]}::bigint) AS locked`;
      signal(row?.locked === true);
      if (row?.locked) await released;
    },
    { timeout: MAX_HOLD_MS },
  );

  // The holder settling first means it failed before deciding (e.g. no connection): rethrow that.
  if (!(await Promise.race([locked, holder.then(() => false)]))) {
    await holder;
    return { acquired: false };
  }
  try {
    return { acquired: true, result: await fn() };
  } finally {
    release();
    // A holder that timed out already let the lock go; the run itself has finished, so that's moot.
    await holder.catch(() => {});
  }
}
