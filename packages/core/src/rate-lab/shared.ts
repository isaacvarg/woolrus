import { type Db, type DbTx, Prisma } from "@woolrus/db";

// Small helpers the Rate Lab services share.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows grouped by `key`, in first-seen order, each group in the rows' order. */
export function groupBy<K, T>(rows: Iterable<T>, key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const quotedColumn = {
  address: Prisma.raw("lab_address_id"),
  parcel: Prisma.raw("lab_parcel_id"),
} as const;

/** When each test address (or parcel) was last quoted, from rate history's lab fetches. */
export async function lastQuoted(
  db: Db | DbTx,
  kind: keyof typeof quotedColumn,
  ids: string[],
): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const column = quotedColumn[kind];
  const rows = await db.$queryRaw<{ id: string; at: Date }[]>`
    SELECT ${column} AS id, max(fetched_at) AS at
    FROM rate_fetches
    WHERE ${column} = ANY(${ids}::uuid[])
    GROUP BY ${column}`;
  return new Map(rows.map((r) => [r.id, r.at]));
}
