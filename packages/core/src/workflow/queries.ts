import { type QueueCounts, type QueuePage, QueueStage, StageSlaMinutes } from "@woolrus/contracts";
import { type DbTx, Prisma, type WorkflowStatus } from "@woolrus/db";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";

// Read models for the floor (SPEC-workflow "Reads"). Queues are keyset-paged on the
// (status, priority desc, ordered_at) index and searched in Postgres, so they stay fast with
// thousands of open orders.

export type ListQueueInput = {
  stage: QueueStage;
  search?: string;
  cursor?: string;
  limit?: number;
};

export type QueryOptions = { now?: Date };

/** Where the previous page stopped, in sort order: priority desc, orderedAt asc, id asc. */
type Cursor = { priority: number; orderedAt: Date; id: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor({ priority, orderedAt, id }: Cursor): string {
  return Buffer.from(JSON.stringify([priority, orderedAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  try {
    const [priority, orderedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const at = new Date(orderedAt);
    if (Number.isInteger(priority) && !Number.isNaN(at.getTime()) && uuid.test(id)) {
      return { priority, orderedAt: at, id };
    }
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

function afterCursor(cursor: Cursor | null): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  const { priority, orderedAt, id } = cursor;
  return Prisma.sql`AND (o.priority < ${priority}
    OR (o.priority = ${priority} AND (o.ordered_at > ${orderedAt}
      OR (o.ordered_at = ${orderedAt} AND o.id > ${id}::uuid))))`;
}

type QueueSqlRow = {
  id: string;
  number: string;
  customerName: string;
  itemCount: number;
  priority: number;
  orderedAt: Date;
  stageEnteredAt: Date;
  claimedById: string | null;
  claimedAt: Date | null;
  claimerName: string | null;
  externalChange: boolean;
  holdReason: string | null;
  heldFromStatus: WorkflowStatus | null;
  version: number;
};

/**
 * One queue, most urgent first: priority desc, then the oldest order. `nextCursor` is null on the
 * last page. Claims show only while live; the item count is active units of physical lines.
 */
export async function listQueue(
  db: DbTx,
  actor: Actor,
  { stage, search, cursor, limit = 50 }: ListQueueInput,
  { now = new Date() }: QueryOptions = {},
): Promise<QueuePage> {
  assertCan(actor, "order.read");
  const after = cursor ? decodeCursor(cursor) : null;
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 100);

  const settings = await loadSettings(db);
  const claimCutoff = new Date(now.getTime() - settings.claimExpiryMinutes * 60_000);
  // Stored JSON that no longer fits reads as "no SLA", as in the settings service.
  const slas = StageSlaMinutes.safeParse(settings.stageSlaMinutes);
  const sla = stage !== "ON_HOLD" && slas.success ? slas.data[stage] : undefined;

  const rows = await db.$queryRaw<QueueSqlRow[]>`
    SELECT o.id, o.number, o.customer_name AS "customerName", o.priority,
      o.ordered_at AS "orderedAt", o.status_changed_at AS "stageEnteredAt",
      o.claimed_by_id AS "claimedById", o.claimed_at AS "claimedAt", u.name AS "claimerName",
      o.external_change_detected_at IS NOT NULL AS "externalChange",
      o.hold_reason AS "holdReason", o.held_from_status::text AS "heldFromStatus", o.version,
      COALESCE((
        SELECT SUM(GREATEST(i.quantity - COALESCE((
          SELECT SUM(v.quantity) FROM item_voids v
          WHERE v.order_item_id = i.id AND v.undone_at IS NULL
        ), 0), 0))
        FROM order_items i LEFT JOIN products p ON p.id = i.product_id
        WHERE i.order_id = o.id AND COALESCE(p.physical, true)
      ), 0)::int AS "itemCount"
    FROM orders o
    LEFT JOIN users u ON u.id = o.claimed_by_id AND o.claimed_at > ${claimCutoff}
    WHERE o.status = ${stage}::workflow_status
      ${searchFilter(search)}
      ${afterCursor(after)}
    ORDER BY o.priority DESC, o.ordered_at ASC, o.id ASC
    LIMIT ${pageSize + 1}`;

  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    rows: page.map((r) => ({
      id: r.id,
      number: r.number,
      customerName: r.customerName,
      itemCount: r.itemCount,
      priority: r.priority,
      orderedAt: r.orderedAt,
      stageEnteredAt: r.stageEnteredAt,
      slaBreached:
        typeof sla === "number" && now.getTime() - r.stageEnteredAt.getTime() > sla * 60_000,
      claim:
        r.claimerName !== null && r.claimedById && r.claimedAt
          ? { userId: r.claimedById, userName: r.claimerName, at: r.claimedAt }
          : null,
      externalChange: r.externalChange,
      holdReason: r.holdReason,
      heldFromStatus: r.heldFromStatus,
      version: r.version,
    })),
    nextCursor: rows.length > pageSize && last ? encodeCursor(last) : null,
  };
}

/** How many orders wait in each queue, for the nav. */
export async function queueCounts(db: DbTx, actor: Actor): Promise<QueueCounts> {
  assertCan(actor, "order.read");
  const groups = await db.order.groupBy({
    by: ["status"],
    where: { status: { in: QueueStage.options } },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(QueueStage.options.map((s) => [s, 0])) as QueueCounts;
  for (const g of groups) counts[g.status as QueueStage] = g._count._all;
  return counts;
}
