import type { ActivityItem } from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import { actionSpec, categoryForEntity } from "./actions";
import { hiddenActions } from "./sources/audit-rows";

// What `stageIntervals` needs from many orders at once (the Cycle time report): the same records
// the timeline's sources read for one order (stage events, visible audit rows, scan misses), cut
// down to the fields the summary uses. A new source in `sources/index.ts` that carries actions by
// people belongs here too, or the report and the History tab would disagree.

/** Orders are read this many at a time. */
const BATCH = 500;

const person = (actorId: string | null) => (actorId ? { id: actorId, name: "" } : null);

/** Each order's summary items, in no particular order; an order with none maps to `[]`. */
export async function summaryItems(
  db: DbTx,
  orderIds: readonly string[],
): Promise<Map<string, ActivityItem[]>> {
  const byOrder = new Map<string, ActivityItem[]>(orderIds.map((id) => [id, []]));
  const add = (orderId: string | null, item: ActivityItem) => {
    if (orderId) byOrder.get(orderId)?.push(item);
  };
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const ids = orderIds.slice(i, i + BATCH);
    const [events, audits, misses] = await Promise.all([
      db.orderStageEvent.findMany({
        where: { orderId: { in: ids } },
        select: {
          id: true,
          orderId: true,
          at: true,
          actorId: true,
          fromStatus: true,
          toStatus: true,
        },
      }),
      db.auditEvent.findMany({
        where: { orderId: { in: ids }, action: { notIn: hiddenActions } },
        select: {
          id: true,
          orderId: true,
          at: true,
          actorId: true,
          action: true,
          entityType: true,
        },
      }),
      db.scanMiss.findMany({
        where: { orderId: { in: ids } },
        select: { id: true, orderId: true, at: true, actorId: true },
      }),
    ]);
    for (const e of events) {
      add(e.orderId, {
        ...blank(e.id, e.at, e.actorId),
        category: "status",
        action: e.fromStatus ? "stage.move" : "stage.import",
        entityType: "Order",
        params: { from: e.fromStatus, to: e.toStatus },
      });
    }
    for (const a of audits) {
      add(a.orderId, {
        ...blank(a.id, a.at, a.actorId),
        category: actionSpec(a.entityType, a.action)?.category ?? categoryForEntity(a.entityType),
        action: a.action,
        entityType: a.entityType,
      });
    }
    for (const m of misses) {
      add(m.orderId, {
        ...blank(m.id, m.at, m.actorId),
        category: categoryForEntity("ScanMiss"),
        action: "scanMiss",
        entityType: "ScanMiss",
      });
    }
  }
  return byOrder;
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
