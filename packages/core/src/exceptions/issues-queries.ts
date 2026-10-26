import type {
  IssueAssignee,
  IssueCounts,
  IssueListInput,
  IssueListPage,
  IssueRow,
} from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { issueInclude, toIssueView } from "./issues";
import { searchFilter, uuid } from "./search";

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

/**
 * Active users for the "Change responsible" picker; reporters can't reach `users.list`. Names only:
 * every signed-in reader gets this list, so it never falls back to an email address.
 */
export async function issueAssignees(db: DbTx, actor: Actor): Promise<IssueAssignee[]> {
  assertCan(actor, "order.read");
  const users = await db.user.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  // A user who hasn't set a name yet still has to be pickable.
  return users.map((u) => ({ id: u.id, name: u.name.trim() || "—" }));
}
