import type { ApprovalInput } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { recordApproval, verifyApprover } from "../identity/approvals";
import type { Actor } from "../permissions";
import type { GateSnapshot } from "../workflow/gates";

// Approving blocking packing checks (SPEC-packing A1 "Gate change"). The credential travels with
// completePacking: it's checked before the move's transaction (so a wrong PIN counts even though
// the move fails), and the approval is written inside it, only when something actually blocks.

/** Who may approve a blocking trip: QA and Admin. */
export const PACK_CHECK_APPROVE = "packCheck.approve";

/** An approval whose credential `verifyApprover` accepted, ready to record with the move. */
export type VerifiedApproval = { approverId: string; reason: string };

/** Checks the approver's PIN or badge before the move's transaction; nothing sent, nothing to check. */
export async function verifyPackApproval(
  db: Db,
  actor: Actor,
  approval: ApprovalInput | undefined,
  now: Date,
): Promise<VerifiedApproval | undefined> {
  if (!approval) return undefined;
  const { approverId } = await verifyApprover(db, actor, {
    credential: approval.credential,
    permission: PACK_CHECK_APPROVE,
    now,
  });
  return { approverId, reason: approval.reason };
}

/** The gate snapshot's blocking trips, as the approval's details record them. */
export function blockingTrips(snapshot: GateSnapshot) {
  return snapshot.packages.flatMap((p) =>
    p.trips
      .filter((trip) => trip.mode === "BLOCK")
      .map((trip) => ({ package: p.number, check: trip.check, details: trip.details })),
  );
}

/**
 * Writes the `Approval` for the order's blocking trips, inside the move's transaction, and returns
 * its id for the saved trip rows. With nothing blocking an approval is ignored and no row is
 * written, so a careless client can't create approvals.
 */
export async function recordPackApproval(
  tx: DbTx,
  actor: Actor,
  {
    orderId,
    approval,
    snapshot,
    now,
  }: {
    orderId: string;
    approval: VerifiedApproval | undefined;
    snapshot: GateSnapshot | undefined;
    now: Date;
  },
): Promise<string | null> {
  const blocking = snapshot ? blockingTrips(snapshot) : [];
  if (!approval || blocking.length === 0) return null;
  return recordApproval(tx, actor, {
    approverId: approval.approverId,
    permission: PACK_CHECK_APPROVE,
    kind: "PACKING_CHECKS",
    entityType: "Order",
    entityId: orderId,
    reason: approval.reason,
    details: blocking,
    now,
  });
}
