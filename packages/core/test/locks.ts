import type { Db } from "@woolrus/db";

/**
 * Makes a race deterministic. Holds `FOR NO KEY UPDATE` on `table` rows `ids` from a separate
 * transaction, starts `contenders`, waits until `waiters` backends are queued on a lock (or 2 s,
 * for code that never takes one: then the contenders simply run), and only then lets go. So the
 * contenders really overlap, instead of `Promise.allSettled` happening to run them one by one.
 */
export async function raceBehindLock<T>(
  db: Db,
  { table, ids, waiters }: { table: "users" | "stations"; ids: string[]; waiters: number },
  contenders: () => Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = db.$transaction(
    async (tx) => {
      // The table name can't be a bind parameter; it comes from the type above, never from input.
      await tx.$queryRawUnsafe(
        `SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) FOR NO KEY UPDATE`,
        ids,
      );
      locked();
      await released;
    },
    { timeout: 20_000 },
  );
  await isLocked;
  const results = Promise.allSettled(contenders());
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.count ?? 0) >= waiters) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  release();
  await holder;
  return results;
}
