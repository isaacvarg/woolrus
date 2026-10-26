import type { DbTx } from "@woolrus/db";

// Helpers other modules call (SPEC-exceptions "Helpers for other modules"). `qa` builds its gate
// (FR-QA-05) and its per-item flag on these.

/** The order's issues that are still open and Critical. */
export async function openCriticalIssues(tx: DbTx, orderId: string) {
  return tx.qualityIssue.findMany({
    where: { orderId, status: "OPEN", severity: "CRITICAL" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, orderItemId: true, packageId: true, type: true },
  });
}

export async function hasOpenCriticalIssue(tx: DbTx, orderId: string): Promise<boolean> {
  return (
    (await tx.qualityIssue.count({ where: { orderId, status: "OPEN", severity: "CRITICAL" } })) > 0
  );
}
