import type { CompletePickInput, CompletePickResult } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { type Actor, assertCan } from "../permissions";
import { claimExpiryMinutes, writeClaim } from "../workflow/claims";
import { lockOrder } from "../workflow/lock";
import { transition } from "../workflow/service";

// Finishing a single order (SPEC-picking "Reads", decision 6): workflow's completePicking, then
// where the picker goes next, in one transaction. A gate failure or a stale version moves nothing.

export type CompletePickOptions = { now?: Date };

/**
 * Locks the first Pending order in queue order (priority desc, oldest first) that nobody else holds
 * a live claim on. SKIP LOCKED: a picker finishing at the same moment takes the next one instead.
 */
async function lockNextPending(
  tx: DbTx,
  actor: Actor,
  now: Date,
): Promise<{ id: string; version: number } | null> {
  const cutoff = new Date(now.getTime() - (await claimExpiryMinutes(tx)) * 60_000);
  const [row] = await tx.$queryRaw<{ id: string; version: number }[]>`
    SELECT id, version FROM orders
    WHERE status = 'PENDING'
      AND (claimed_by_id IS NULL OR claimed_by_id = ${actor.userId}::uuid OR claimed_at <= ${cutoff})
    ORDER BY priority DESC, ordered_at ASC, id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;
  return row ?? null;
}

/**
 * Completes picking, then by `after`: `queue` nothing more; `next` begins picking the next unclaimed
 * Pending order and returns its id (null when none is left); `pack` claims the order in Packing for
 * the actor.
 */
export async function completePick(
  db: Db,
  actor: Actor,
  { orderId, expectedVersion, after }: CompletePickInput,
  { now = new Date() }: CompletePickOptions = {},
): Promise<CompletePickResult> {
  assertCan(actor, "order.pick");
  if (after === "pack") assertCan(actor, "order.pack");

  return db.$transaction(async (tx) => {
    await transition(
      tx,
      actor,
      { orderId, expectedVersion, to: "PACKING", kind: "completePicking" },
      { now },
    );

    if (after === "pack") {
      // completePicking just cleared the claim, so there's nobody's claim to refuse over.
      await writeClaim(tx, actor, await lockOrder(tx, orderId), {
        action: "order.claim",
        live: false,
        now,
      });
      return { nextOrderId: null };
    }

    if (after === "next") {
      const next = await lockNextPending(tx, actor, now);
      if (!next) return { nextOrderId: null };
      await transition(
        tx,
        actor,
        { orderId: next.id, expectedVersion: next.version, to: "PICKING", kind: "beginPicking" },
        { now },
      );
      return { nextOrderId: next.id };
    }

    return { nextOrderId: null };
  });
}
