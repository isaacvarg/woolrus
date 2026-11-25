import { createDb, type Db } from "@woolrus/db";
import type { Actor, UserActor } from "../src/permissions";

export function testDb(): Db {
  return createDb(process.env.TEST_DATABASE_URL);
}

/**
 * Empties every table except Prisma's migration log, and restarts the sequences. Only the tables
 * that hold rows are truncated: TRUNCATE gives each table new files, and doing that to all of them
 * before every test is what made the suite disk-bound once files ran in parallel.
 */
export async function resetDb(db: Db): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    // Table names come from the catalog, never from input.
    const probe = tables
      .map(
        ({ tablename }) =>
          `SELECT '${tablename}' AS tablename WHERE EXISTS (SELECT 1 FROM "public"."${tablename}")`,
      )
      .join(" UNION ALL ");
    const full = await db.$queryRawUnsafe<{ tablename: string }[]>(probe);
    const names = full.map((r) => `"public"."${r.tablename}"`).join(", ");
    if (names) await db.$executeRawUnsafe(`TRUNCATE ${names} CASCADE`);
  }
  // Like RESTART IDENTITY, and also for tables that are empty but used a number (a rolled-back insert).
  await db.$queryRaw`
    SELECT setval(format('%I.%I', schemaname, sequencename)::regclass, start_value, false)
    FROM pg_sequences WHERE schemaname = 'public'`;
}

export async function createActor(db: Db, roles: Actor["roles"]): Promise<UserActor> {
  const user = await db.user.create({
    data: { name: "Test User", email: `${crypto.randomUUID()}@example.test`, roles: [...roles] },
  });
  return { userId: user.id, roles, stationId: null };
}
