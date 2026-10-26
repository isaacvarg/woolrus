import {
  LineAttribute,
  type OrderAddress,
  type OrderHistoryEntry,
  type OrderListPage,
  type OrderListSort,
  type OrderView,
  type QueueCounts,
  type QueuePage,
  QueueStage,
  StageSlaMinutes,
} from "@woolrus/contracts";
import { type DbTx, Prisma, type WorkflowStatus } from "@woolrus/db";
import { z } from "zod";
import { AppError, notFound } from "../errors";
import { toVoidView, voidInclude } from "../exceptions/voids";
import { lineAndPackageNoteCounts, noteCounts } from "../notes/targets";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { externalChangeOf } from "../sync/review";
import { allowedActions } from "./actions";
import { toOrderDetails } from "./detail";
import { liveLabelStatuses } from "./gates";
import { displayName, nameFields } from "./people";

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
    // Priority is bound as a Postgres int: anything larger is an error there, not a value.
    const int32 = Number.isInteger(priority) && Math.abs(priority) <= 2_147_483_647;
    if (int32 && !Number.isNaN(at.getTime()) && uuid.test(id)) {
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
  claimerEmail: string | null;
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
      o.claimed_by_id AS "claimedById", o.claimed_at AS "claimedAt", u.name AS "claimerName", u.email AS "claimerEmail",
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
  const notes = await noteCounts(
    db,
    page.map((r) => r.id),
  );
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
        r.claimerName !== null && r.claimerEmail !== null && r.claimedById && r.claimedAt
          ? {
              userId: r.claimedById,
              userName: displayName({ name: r.claimerName, email: r.claimerEmail }),
              at: r.claimedAt,
            }
          : null,
      externalChange: r.externalChange,
      holdReason: r.holdReason,
      heldFromStatus: r.heldFromStatus,
      version: r.version,
      noteCount: notes.get(r.id) ?? 0,
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

const addressFields = [
  "name",
  "company",
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
  "country",
  "phone",
  "email",
] as const;

/** The stored address JSON comes from WooCommerce: keep the string fields we know, drop the rest. */
function toAddress(json: Prisma.JsonValue): OrderAddress {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const address: OrderAddress = {};
  for (const field of addressFields) {
    const value = json[field];
    if (typeof value === "string") address[field] = value;
  }
  return address;
}

const StoredAttributes = z.array(LineAttribute);

/** Stored JSON that isn't a list of attributes (older shape, hand edits) reads as none. */
export function toAttributes(stored: Prisma.JsonValue): LineAttribute[] {
  const parsed = StoredAttributes.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** One order for its detail page, with the buttons the caller may use. */
export async function getOrder(
  db: DbTx,
  actor: Actor,
  { id }: { id: string },
  { now = new Date() }: QueryOptions = {},
): Promise<OrderView> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          product: { select: { physical: true } },
          voids: { where: { undoneAt: null }, select: { quantity: true } },
          pickedBy: { select: nameFields },
        },
      },
      packages: {
        orderBy: { number: "asc" },
        include: {
          box: { select: { name: true } },
          items: { select: { orderItemId: true, quantity: true }, orderBy: { packedAt: "asc" } },
          labels: { where: { status: { in: [...liveLabelStatuses] } }, select: { id: true } },
        },
      },
    },
  });
  if (!order) throw notFound();

  const [detail] = await toOrderDetails(db, [order], { now });
  const notes = await lineAndPackageNoteCounts(db, id);
  const voids = await db.itemVoid.findMany({
    where: { orderId: id },
    include: voidInclude,
    orderBy: [{ voidedAt: "desc" }, { id: "desc" }],
  });
  if (!detail) throw notFound();
  const externalChange = externalChangeOf(order);
  const names = new Map(order.items.map((i) => [i.id, i.name]));
  return {
    ...detail,
    externalChange,
    customerEmail: order.customerEmail,
    customerNote: order.customerNote,
    shippingAddress: toAddress(order.shippingAddress),
    billingAddress: toAddress(order.billingAddress),
    lines: order.items.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      imageUrl: i.imageUrl,
      quantity: i.quantity,
      activeQuantity: Math.max(i.quantity - i.voids.reduce((sum, v) => sum + v.quantity, 0), 0),
      // A line whose product row is gone counts as physical (SPEC-workflow "Schema additions").
      physical: i.product?.physical ?? true,
      pickStatus: i.pickStatus,
      pickedQuantity: i.pickedQuantity,
      substitutionNote: i.substitutionNote,
      pickedBy: i.pickedBy ? { name: displayName(i.pickedBy) } : null,
      pickedAt: i.pickedAt,
      attributes: toAttributes(i.attributes),
      noteCount: notes.items.get(i.id) ?? 0,
    })),
    packages: order.packages.map((p) => ({
      id: p.id,
      number: p.number,
      boxName: p.box?.name ?? null,
      dimensions:
        p.lengthIn && p.widthIn && p.heightIn
          ? {
              lengthIn: p.lengthIn.toNumber(),
              widthIn: p.widthIn.toNumber(),
              heightIn: p.heightIn.toNumber(),
            }
          : null,
      weightOz: p.weightOz === null ? null : p.weightOz.toNumber(),
      units: p.items.reduce((sum, it) => sum + it.quantity, 0),
      items: p.items.map((it) => ({
        orderItemId: it.orderItemId,
        name: names.get(it.orderItemId) ?? "",
        quantity: it.quantity,
      })),
      liveLabel: p.labels.length > 0,
      noteCount: notes.packages.get(p.id) ?? 0,
    })),
    voids: voids.map(toVoidView),
    allowedActions: allowedActions(actor, {
      status: order.status,
      heldFromStatus: order.heldFromStatus,
      liveClaimHolderId: detail.claim?.userId ?? null,
      externalChange: externalChange !== null,
    }),
  };
}

/** Audit actions that belong in the history panel next to stage changes. */
const claimActions = {
  "order.claim": "claim",
  "order.takeOver": "takeOver",
  "order.release": "release",
} as const;

const previousHolderId = (before: Prisma.JsonValue): string | null =>
  before &&
  typeof before === "object" &&
  !Array.isArray(before) &&
  typeof before.claimedById === "string"
    ? before.claimedById
    : null;

/** Stage changes and claim moves, newest first, with who and where (FR-WF-05). */
export async function getOrderHistory(
  db: DbTx,
  actor: Actor,
  { id }: { id: string },
): Promise<OrderHistoryEntry[]> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({ where: { id }, select: { id: true } });
  if (!order) throw notFound();

  const names = { actor: { select: nameFields }, station: { select: { name: true } } };
  const [stages, audits] = await Promise.all([
    db.orderStageEvent.findMany({ where: { orderId: id }, include: names }),
    db.auditEvent.findMany({
      where: { entityType: "Order", entityId: id, action: { in: Object.keys(claimActions) } },
      include: names,
    }),
  ]);

  const takenFrom = audits.flatMap((a) =>
    a.action === "order.takeOver" ? [previousHolderId(a.before)].filter((x) => x !== null) : [],
  );
  const holders = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(takenFrom)] } },
        select: { id: true, ...nameFields },
      })
    ).map((u) => [u.id, displayName(u)]),
  );

  // A null actorId means store sync: people are deactivated, never deleted, so SetNull never fires.
  const entries: OrderHistoryEntry[] = [
    ...stages.map((e) => ({
      id: e.id,
      at: e.at,
      type: "stage" as const,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      reason: e.reason,
      actorName: e.actor ? displayName(e.actor) : null,
      bySystem: e.actorId === null,
      stationName: e.station?.name ?? null,
      previousHolderName: null,
    })),
    ...audits.map((a) => {
      const type = claimActions[a.action as keyof typeof claimActions];
      const previous = type === "takeOver" ? previousHolderId(a.before) : null;
      return {
        id: a.id,
        at: a.at,
        type,
        fromStatus: null,
        toStatus: null,
        reason: null,
        actorName: a.actor ? displayName(a.actor) : null,
        bySystem: a.actorId === null,
        stationName: a.station?.name ?? null,
        previousHolderName: previous ? (holders.get(previous) ?? null) : null,
      };
    }),
  ];
  // Ids are UUIDv7, so they break ties in write order.
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
}

export type ListOrdersInput = {
  search?: string;
  statuses?: WorkflowStatus[];
  sort?: OrderListSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

function orderBy(sort: OrderListSort, dir: "asc" | "desc"): Prisma.Sql {
  const d = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
  switch (sort) {
    // Woo order numbers are digits: shorter is smaller, so "999" sorts before "1000".
    case "number":
      return Prisma.sql`length(o.number) ${d}, o.number ${d}`;
    case "customer":
      return Prisma.sql`lower(o.customer_name) ${d}, o.ordered_at DESC`;
    // The enum's declared order is the workflow's.
    case "status":
      return Prisma.sql`o.status ${d}, o.ordered_at DESC`;
    case "priority":
      return Prisma.sql`o.priority ${d}, o.ordered_at ASC`;
    case "orderedAt":
      return Prisma.sql`o.ordered_at ${d}`;
  }
}

type OrderListSqlRow = {
  id: string;
  number: string;
  customerName: string;
  status: WorkflowStatus;
  priority: number;
  orderedAt: Date;
  statusChangedAt: Date;
  externalChange: boolean;
};

/** All Orders: every status, filtered, sorted and offset-paged with a total. */
export async function listOrders(
  db: DbTx,
  actor: Actor,
  { search, statuses, sort = "orderedAt", dir = "desc", page = 1, pageSize = 50 }: ListOrdersInput,
): Promise<OrderListPage> {
  assertCan(actor, "order.read");
  const size = Math.min(Math.max(Math.trunc(pageSize), 1), 100);
  const pageNumber = Math.max(Math.trunc(page), 1);

  const where = Prisma.sql`WHERE TRUE
    ${statuses?.length ? Prisma.sql`AND o.status = ANY(${statuses}::workflow_status[])` : Prisma.empty}
    ${searchFilter(search)}`;

  const [rows, [count]] = await Promise.all([
    db.$queryRaw<OrderListSqlRow[]>`
      SELECT o.id, o.number, o.customer_name AS "customerName", o.status::text AS status,
        o.priority, o.ordered_at AS "orderedAt", o.status_changed_at AS "statusChangedAt",
        o.external_change_detected_at IS NOT NULL AS "externalChange"
      FROM orders o
      ${where}
      ORDER BY ${orderBy(sort, dir)}, o.id ASC
      LIMIT ${size} OFFSET ${(pageNumber - 1) * size}`,
    db.$queryRaw<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM orders o ${where}`,
  ]);

  const notes = await noteCounts(
    db,
    rows.map((r) => r.id),
  );
  return {
    rows: rows.map((r) => ({ ...r, noteCount: notes.get(r.id) ?? 0 })),
    total: count?.total ?? 0,
    page: pageNumber,
    pageSize: size,
  };
}
