import { createDb, type Db } from "@woolrus/db";
import type { Actor } from "../src/permissions";

export function testDb(): Db {
  return createDb(process.env.TEST_DATABASE_URL);
}

/** Empties every table except Prisma's migration log. */
export async function resetDb(db: Db): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  if (tables) await db.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

export async function createActor(db: Db, roles: Actor["roles"]): Promise<Actor> {
  const user = await db.user.create({
    data: { name: "Test User", email: `${crypto.randomUUID()}@example.test`, roles: [...roles] },
  });
  return { userId: user.id, roles, stationId: null };
}
