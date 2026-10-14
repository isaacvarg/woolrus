import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export { Prisma } from "./generated/prisma/client";

export type Db = InstanceType<typeof PrismaClient>;
/** A client or an interactive-transaction client; services accept either. */
export type DbTx = Omit<Db, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

/** Connections are opened lazily, so importing this module never needs DATABASE_URL (e.g. during `next build`). */
export function createDb(connectionString = process.env.DATABASE_URL): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForDb = globalThis as unknown as { woolrusDb?: Db };

/** Shared client. Cached on globalThis so Next.js dev reloads don't open new pools. */
export const db: Db = globalForDb.woolrusDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.woolrusDb = db;
