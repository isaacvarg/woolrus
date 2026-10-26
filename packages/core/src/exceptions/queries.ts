import type {
  IssueAssignee,
  IssueCounts,
  IssueListInput,
  IssueListPage,
  IssueRow,
  VoidCounts,
  VoidListInput,
  VoidListPage,
  VoidListStatus,
} from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { displayName, nameFields } from "../workflow/people";
import { issueInclude, toIssueView } from "./issues";
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

// The Issues page (SPEC-exceptions "Reads"). Open Critical issues lead, then newest first; the
// cursor carries that rank so paging doesn't skip or repeat a row.

const orderSelect = { select: { number: true, customerName: true } } as const;

const withOrder = (
  row: Parameters<typeof toIssueView>[0] & { order: { number: string; customerName: string } },
): IssueRow => ({
  ...toIssueView(row),
  orderNumber: row.order.number,
  customerName: row.order.customerName,
});

type IssueCursor = { rank: number; at: Date; id: string };

function decodeIssueCursor(cursor: string): IssueCursor {
  try {
    const [rank, iso, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const at = new Date(iso);
    if ((rank === 0 || rank === 1) && !Number.isNaN(at.getTime()) && uuid.test(id)) {
      return { rank, at, id };
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new AppError("BAD_REQUEST", "errors.validation", { cursor: "errors.field.invalid" });
}

const issueStatusFilter = (status: IssueListInput["status"]): Prisma.Sql =>
  status === "open"
    ? Prisma.sql`AND i.status = 'OPEN'`
    : status === "resolved"
      ? Prisma.sql`AND i.status <> 'OPEN'`
      : Prisma.empty;

export async function listIssues(
  db: DbTx,
  actor: Actor,
  { status = "all", severity, type, orderId, search, cursor, limit = 50 }: Partial<IssueListInput>,
): Promise<IssueListPage> {
  assertCan(actor, "order.read");
  const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const after = cursor ? decodeIssueCursor(cursor) : null;
  const rank = Prisma.sql`(CASE WHEN i.status = 'OPEN' AND i.severity = 'CRITICAL' THEN 0 ELSE 1 END)`;

  const page = await db.$queryRaw<{ id: string; rank: number; at: Date }[]>`
    SELECT i.id, ${rank} AS rank, i.created_at AS at
    FROM quality_issues i JOIN orders o ON o.id = i.order_id
    WHERE TRUE ${issueStatusFilter(status)}
      ${severity ? Prisma.sql`AND i.severity = ${severity}::quality_issue_severity` : Prisma.empty}
      ${type ? Prisma.sql`AND i.type = ${type}::quality_issue_type` : Prisma.empty}
      ${orderId ? Prisma.sql`AND i.order_id = ${orderId}::uuid` : Prisma.empty}
      ${searchFilter(search)}
      ${
        after
          ? Prisma.sql`AND (${rank}, i.created_at, i.id) < (${after.rank}, ${after.at}, ${after.id}::uuid)`
          : Prisma.empty
      }
    ORDER BY ${rank} ASC, i.created_at DESC, i.id DESC
    LIMIT ${size + 1}`;
  const ids = page.slice(0, size).map((r) => r.id);
  const last = page[size - 1];
  const rows = await db.qualityIssue.findMany({
    where: { id: { in: ids } },
    include: { ...issueInclude, order: orderSelect },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    rows: ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [withOrder(row)] : [];
    }),
    nextCursor:
      page.length > size && last
        ? Buffer.from(JSON.stringify([Number(last.rank), last.at.toISOString(), last.id])).toString(
            "base64url",
          )
        : null,
  };
}

export async function getIssue(db: DbTx, actor: Actor, issueId: string): Promise<IssueRow> {
  assertCan(actor, "order.read");
  const row = await db.qualityIssue.findUnique({
    where: { id: issueId },
    include: { ...issueInclude, order: orderSelect },
  });
  if (!row) throw notFound();
  return withOrder(row);
}

/** Open issues for the nav: the count, and how many of them are Critical (the red dot). */
export async function issueCounts(db: DbTx, actor: Actor): Promise<IssueCounts> {
  assertCan(actor, "order.read");
  const [open, openCritical] = await Promise.all([
    db.qualityIssue.count({ where: { status: "OPEN" } }),
    db.qualityIssue.count({ where: { status: "OPEN", severity: "CRITICAL" } }),
  ]);
  return { open, openCritical };
}

/** Active users for the "Change responsible" picker; reporters can't reach `users.list`. */
export async function issueAssignees(db: DbTx, actor: Actor): Promise<IssueAssignee[]> {
  assertCan(actor, "order.read");
  const users = await db.user.findMany({
    where: { active: true },
    select: { id: true, ...nameFields },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return users.map((u) => ({ id: u.id, name: displayName(u) }));
}

// Helpers other modules call (SPEC-exceptions "Helpers for other modules"). `qa` builds its gate
// (FR-QA-05) and its per-item flag on these.

/** The order's issues that are still open and Critical. */
export async function openCriticalIssues(tx: DbTx, orderId: string) {
  return tx.qualityIssue.findMany({
    where: { orderId, status: "OPEN", severity: "CRITICAL" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, orderItemId: true, packageId: true, type: true },
  });
}

export async function hasOpenCriticalIssue(tx: DbTx, orderId: string): Promise<boolean> {
  return (
    (await tx.qualityIssue.count({ where: { orderId, status: "OPEN", severity: "CRITICAL" } })) > 0
  );
}
