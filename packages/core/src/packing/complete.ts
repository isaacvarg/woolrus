import type { CompletePackInput, CompletePackResult } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { createTextNote } from "../notes/service";
import { type Actor, assertCan } from "../permissions";
import { formatWeight } from "../settings/format";
import { loadSettings } from "../settings/service";
import { toNumber } from "../units";
import { claimExpiryMinutes, writeClaim } from "../workflow/claims";
import { lockOrder } from "../workflow/lock";
import { transition } from "../workflow/service";

// Finishing an order (SPEC-packing "Finishing"): workflow's completePacking, the re-weigh notes,
// and where the packer goes next, in one transaction. A gate failure or a stale version moves
// nothing and writes no note.

export type CompletePackOptions = { now?: Date };

/**
 * Locks the first Packing order in queue order (priority desc, oldest first) that nobody else holds
 * a live claim on. SKIP LOCKED: a packer finishing at the same moment takes the next one instead.
 */
async function lockNextPacking(tx: DbTx, actor: Actor, now: Date): Promise<{ id: string } | null> {
  const cutoff = new Date(now.getTime() - (await claimExpiryMinutes(tx)) * 60_000);
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders
    WHERE status = 'PACKING'
      AND (claimed_by_id IS NULL OR claimed_by_id = ${actor.userId}::uuid OR claimed_at <= ${cutoff})
    ORDER BY priority DESC, ordered_at ASC, id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;
  return row ?? null;
}

/**
 * A package whose contents or box changed after it was weighed, and whose weight nobody re-checked
 * or confirmed, gets one internal note, so QA sees it on the package (SPEC-packing decision 5).
 */
async function noteStaleWeights(tx: DbTx, actor: Actor, orderId: string): Promise<void> {
  const stale = await tx.package.findMany({
    where: { orderId, weightStale: true, weightOz: { not: null } },
    orderBy: { number: "asc" },
    select: { id: true, weightOz: true },
  });
  if (stale.length === 0) return;
  const { weightDisplay } = await loadSettings(tx);
  for (const pkg of stale) {
    const weight = formatWeight(toNumber(pkg.weightOz) ?? 0, weightDisplay, "en");
    await createTextNote(tx, actor, {
      orderId,
      packageId: pkg.id,
      content: `Contents changed after weighing; weight ${weight} not re-checked`,
    });
  }
}

/** Completes packing, then by `after`: `queue` nothing more; `next` claims the next Packing order. */
export async function completePack(
  db: Db,
  actor: Actor,
  { orderId, expectedVersion, after }: CompletePackInput,
  { now = new Date() }: CompletePackOptions = {},
): Promise<CompletePackResult> {
  assertCan(actor, "order.pack");

  return db.$transaction(async (tx) => {
    await transition(
      tx,
      actor,
      { orderId, expectedVersion, to: "QA", kind: "completePacking" },
      { now },
    );
    await noteStaleWeights(tx, actor, orderId);

    if (after === "next") {
      const next = await lockNextPacking(tx, actor, now);
      if (!next) return { nextOrderId: null };
      await writeClaim(tx, actor, await lockOrder(tx, next.id), {
        action: "order.claim",
        live: false,
        now,
      });
      return { nextOrderId: next.id };
    }
    return { nextOrderId: null };
  });
}
