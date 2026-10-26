import { Prisma } from "@woolrus/db";

// Shared by the Voids and Issues lists: cursor ids and the order-number / customer search.

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LIKE treats `%`, `_` and `\` as syntax; search text is literal. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchFilter(search: string | undefined): Prisma.Sql {
  const text = search?.trim().replace(/^#/, "").trim();
  if (!text) return Prisma.empty;
  const literal = escapeLike(text);
  return Prisma.sql`AND (o.number ILIKE ${`${literal}%`} OR o.customer_name ILIKE ${`%${literal}%`})`;
}
