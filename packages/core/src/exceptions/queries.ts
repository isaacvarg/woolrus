import type { VoidCounts, VoidListInput, VoidListPage, VoidListStatus } from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { toVoidView, voidInclude } from "./voids";

// Reads for the Voids page and the nav badge (SPEC-exceptions "Reads"). Orders are the unit of
// paging: each carries its voids that match the tab, and an order's place in the list is its
// newest matching void (resolved newest first on the Resolved tab).

/** The voids a tab shows, as a Prisma filter and as SQL for the grouping query. */
const where = (status: VoidListStatus): Prisma.ItemVoidWhereInput =>
  status === "unresolved"
    ? { undoneAt: null, resolvedAt: null }
    : status === "resolved"
      ? { resolvedAt: { not: null } }
      : {};

const sqlFilter = (status: VoidListStatus): Prisma.Sql =>
  status === "unresolved"
    ? Prisma.sql`v.undone_at IS NULL AND v.resolved_at IS NULL`
    : status === "resolved"
      ? Prisma.sql`v.resolved_at IS NOT NULL`
      : Prisma.sql`TRUE`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Cursor = { at: Date; id: string };

const encodeCursor = ({ at, id }: Cursor) =>
  Buffer.from(JSON.stringify([at.toISOString(), id])).toString("base64url");

function decodeCursor(cursor: string): Cursor {
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime()) && uuid.test(id)) return { at, id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new AppError("BAD_REQUEST", "errors.validation", { cursor: "errors.field.invalid" });
}

/** LIKE treats `%`, `_` and `\` as syntax; search text is literal. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchFilter(search: string | undefined): Prisma.Sql {
  const text = search?.trim().replace(/^#/, "").trim();
  if (!text) return Prisma.empty;
  const literal = escapeLike(text);
  return Prisma.sql`AND (o.number ILIKE ${`${literal}%`} OR o.customer_name ILIKE ${`%${literal}%`})`;
}

export async function listVoids(
  db: DbTx,
  actor: Actor,
  { status = "unresolved", search, cursor, limit = 50 }: Partial<VoidListInput>,
): Promise<VoidListPage> {
  assertCan(actor, "order.read");
  const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const after = cursor ? decodeCursor(cursor) : null;
  const at = status === "resolved" ? Prisma.sql`v.resolved_at` : Prisma.sql`v.voided_at`;

  const page = await db.$queryRaw<{ id: string; at: Date }[]>`
    SELECT o.id, MAX(${at}) AS at
    FROM item_voids v JOIN orders o ON o.id = v.order_id
    WHERE ${sqlFilter(status)} ${searchFilter(search)}
    GROUP BY o.id
    ${
      after
        ? Prisma.sql`HAVING MAX(${at}) < ${after.at} OR (MAX(${at}) = ${after.at} AND o.id < ${after.id}::uuid)`
        : Prisma.empty
    }
    ORDER BY at DESC, o.id DESC
    LIMIT ${size + 1}`;
  const rows = page.slice(0, size);
  const last = rows.at(-1);
  const nextCursor = page.length > size && last ? encodeCursor({ at: last.at, id: last.id }) : null;

  const ids = rows.map((r) => r.id);
  const [orders, voids] = await Promise.all([
    db.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, number: true, customerName: true, status: true },
    }),
    db.itemVoid.findMany({
      where: { orderId: { in: ids }, ...where(status) },
      include: voidInclude,
      orderBy: [{ [status === "resolved" ? "resolvedAt" : "voidedAt"]: "desc" }, { id: "desc" }],
    }),
  ]);
  const byId = new Map(orders.map((o) => [o.id, o]));
  return {
    groups: rows.flatMap(({ id }) => {
      const order = byId.get(id);
      return order ? [{ order, voids: voids.filter((v) => v.orderId === id).map(toVoidView) }] : [];
    }),
    nextCursor,
  };
}

/** Orders with at least one unresolved void: the Voids nav badge. */
export async function voidCounts(db: DbTx, actor: Actor): Promise<VoidCounts> {
  assertCan(actor, "order.read");
  const [row] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT order_id) AS count FROM item_voids
    WHERE undone_at IS NULL AND resolved_at IS NULL`;
  return { unresolvedOrders: Number(row?.count ?? 0) };
}
