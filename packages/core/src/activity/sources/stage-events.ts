import type { ActivitySource } from "./types";

const people = {
  actor: { select: { name: true, email: true } },
  station: { select: { name: true } },
} as const;

/** Status changes. A null actor is store sync: people are deactivated, never deleted. */
export const stageEventSource: ActivitySource = async (db, { orderId, take }) => {
  const events = await db.orderStageEvent.findMany({
    where: { orderId },
    include: people,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take,
  });
  return events.map((e) => ({
    id: e.id,
    at: e.at,
    action: e.fromStatus ? "stage.move" : "stage.import",
    entityType: "Order",
    entityId: orderId,
    actorId: e.actorId,
    actor: e.actor,
    system: "store-sync" as const,
    station: e.station?.name ?? null,
    before: null,
    after: null,
    params: { from: e.fromStatus, to: e.toStatus, reason: e.reason },
    target: null,
    details: false,
  }));
};
