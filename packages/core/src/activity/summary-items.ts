import type { ActivityItem } from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import { actionSpec, categoryForEntity } from "./actions";
import { hiddenActions } from "./sources/audit-rows";

// What `stageIntervals` needs from many orders at once (the Cycle time report): the same records
// the timeline's sources read for one order (stage events, visible audit rows, scan misses), cut
// down to the fields the summary uses. A new source in `sources/index.ts` that carries actions by
// people belongs here too, or the report and the History tab would disagree.

/**
 * Orders are read this many at a time, the batches side by side. One raw query per batch: through
 * `findMany`, mapping the rows took most of a 10,000-order Cycle time read (SPEC-reporting
 * criterion 8, #218).
 */
const BATCH = 2_000;

const person = (actorId: string | null) => (actorId ? { id: actorId, name: "" } : null);

type Row = {
  source: "event" | "audit" | "miss";
  id: string;
  orderId: string;
  /** Epoch milliseconds: the driver parses numbers far faster than timestamps. */
  ms: number;
  actorId: string | null;
  /** Event: from status; audit: action. */
  a: string | null;
  /** Event: to status; audit: entity type. */
  b: string | null;
};

function readBatch(db: DbTx, ids: readonly string[]): Promise<Row[]> {
  const list = [...ids];
  return db.$queryRaw<Row[]>`
    SELECT 'event' AS source, id::text, order_id::text AS "orderId",
      (extract(epoch FROM at) * 1000)::float8 AS ms, actor_id::text AS "actorId",
      from_status::text AS a, to_status::text AS b
    FROM order_stage_events WHERE order_id = ANY(${list}::uuid[])
    UNION ALL
    SELECT 'audit', id::text, order_id::text, (extract(epoch FROM at) * 1000)::float8,
      actor_id::text, action, entity_type
    FROM audit_events
    WHERE order_id = ANY(${list}::uuid[]) AND NOT (action = ANY(${hiddenActions}::text[]))
    UNION ALL
    SELECT 'miss', id::text, order_id::text, (extract(epoch FROM at) * 1000)::float8,
      actor_id::text, NULL, NULL
    FROM scan_misses WHERE order_id = ANY(${list}::uuid[])`;
}

/** Each order's summary items, in no particular order; an order with none maps to `[]`. */
export async function summaryItems(
  db: DbTx,
  orderIds: readonly string[],
): Promise<Map<string, ActivityItem[]>> {
  const byOrder = new Map<string, ActivityItem[]>(orderIds.map((id) => [id, []]));
  const batches: Promise<Row[]>[] = [];
  for (let i = 0; i < orderIds.length; i += BATCH) {
    batches.push(readBatch(db, orderIds.slice(i, i + BATCH)));
  }
  for (const rows of await Promise.all(batches)) {
    for (const row of rows) byOrder.get(row.orderId)?.push(toItem(row));
  }
  return byOrder;
}

function toItem({ source, id, ms, actorId, a, b }: Row): ActivityItem {
  const at = new Date(ms);
  if (source === "event") {
    return {
      ...blank(id, at, actorId),
      category: "status",
      action: a ? "stage.move" : "stage.import",
      entityType: "Order",
      params: { from: a, to: b },
    };
  }
  if (source === "audit") {
    const action = a ?? "";
    const entityType = b ?? "";
    return {
      ...blank(id, at, actorId),
      category: actionSpec(entityType, action)?.category ?? categoryForEntity(entityType),
      action,
      entityType,
    };
  }
  return {
    ...blank(id, at, actorId),
    category: categoryForEntity("ScanMiss"),
    action: "scanMiss",
    entityType: "ScanMiss",
  };
}

function blank(id: string, at: Date, actorId: string | null) {
  return {
    id,
    at,
    actor: person(actorId),
    system: null,
    station: null,
    target: null,
    params: {},
    details: null,
  };
}
