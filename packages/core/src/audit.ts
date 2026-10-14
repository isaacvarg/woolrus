import type { DbTx, Prisma } from "@woolrus/db";
import type { Actor } from "./permissions";

export async function recordAudit(
  tx: DbTx,
  actor: Actor,
  event: {
    entityType: string;
    entityId: string;
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: { ...event, actorId: actor.userId, stationId: actor.stationId },
  });
}
