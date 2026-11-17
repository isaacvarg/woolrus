import type { DbTx, Prisma } from "@woolrus/db";
import type { Actor } from "./permissions";

export async function recordAudit(
  tx: DbTx,
  actor: Actor,
  event: {
    entityType: string;
    entityId: string;
    action: string;
    /**
     * The order this row is about: the order itself, or the order that owns the line, package,
     * label, note, issue, void, check trip or approval. The order's activity feed reads by it.
     */
    orderId?: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    /** Defaults to the database clock. Workflow passes its `now` so audit and stage events agree. */
    at?: Date;
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      ...event,
      actorId: actor.userId,
      stationId: actor.stationId,
      requestId: actor.requestId,
    },
  });
}
