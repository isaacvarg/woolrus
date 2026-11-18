import { actionRegistry } from "../actions";
import type { ActivitySource } from "./types";

/** Actions another entry already shows (a move's audit row, by its stage event). */
export const hiddenActions = Object.entries(actionRegistry)
  .filter(([, spec]) => "hidden" in spec && spec.hidden)
  .map(([action]) => action);

/** Every audit row carrying the order's id (#197), whatever entity it is about. */
export const auditRowSource: ActivitySource = async (db, { orderId, take }) => {
  const rows = await db.auditEvent.findMany({
    where: { orderId, action: { notIn: hiddenActions } },
    include: {
      actor: { select: { name: true, email: true } },
      station: { select: { name: true } },
    },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take,
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    actorId: r.actorId,
    actor: r.actor,
    station: r.station?.name ?? null,
    before: r.before,
    after: r.after,
  }));
};
