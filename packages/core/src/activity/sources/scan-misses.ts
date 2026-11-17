import type { ActivitySource } from "./types";

/** The registry action a miss is worded with (`actions/scan-misses.ts`). */
const actionOf = {
  NOT_ON_ORDER: "scanMiss.notOnOrder",
  UNKNOWN_CODE: "scanMiss.unknownCode",
  ALREADY_DONE: "scanMiss.alreadyDone",
  OTHER_PACKAGE: "scanMiss.otherPackage",
} as const;

/** Scans picking, packing and QA refused (#205). Their fields ride in `after`, not as details. */
export const scanMissSource: ActivitySource = async (db, { orderId, take }) => {
  const misses = await db.scanMiss.findMany({
    where: { orderId },
    include: {
      actor: { select: { name: true, email: true } },
      station: { select: { name: true } },
    },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take,
  });
  return misses.map((m) => ({
    id: m.id,
    at: m.at,
    action: actionOf[m.kind],
    entityType: "ScanMiss",
    entityId: m.id,
    actorId: m.actorId,
    actor: m.actor,
    station: m.station?.name ?? null,
    before: null,
    after: {
      stage: m.stage,
      code: m.code,
      productName: m.productName,
      orderItemId: m.orderItemId,
      packageId: m.packageId,
      batchId: m.batchId,
    },
    details: false,
  }));
};
