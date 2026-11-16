import type { BatchSuggestions } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import type { Actor, UserActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { assertMayPick, batchInclude, closeIfSpent } from "./batches";
import { activeQuantity, isWorkLine, lineInclude } from "./service";
import { shelfKey } from "./shelf";
import { type SuggestionOrder, suggestBatches } from "./suggest";

// Suggested batches read (SPEC-picking A1, "Reads"). Built on every read and never stored: a batch
// made from one is just a batch (A1 decision 4).

/** Enough for a day's queue (50–200 orders, A1 assumption 7) while keeping the read bounded. */
export const SUGGESTION_CANDIDATES = 200;

export type SuggestionOptions = { now?: Date };

/**
 * Pending orders `createBatch` would take for the actor: no live claim by anyone else. In queue
 * order, the first `SUGGESTION_CANDIDATES` of them; those with nothing to pick are then dropped,
 * since there's nothing to walk for.
 */
export async function listSuggestionCandidates(
  tx: DbTx,
  actor: UserActor,
  expiryMinutes: number,
  now: Date,
): Promise<SuggestionOrder[]> {
  const cutoff = new Date(now.getTime() - expiryMinutes * 60_000);
  const orders = await tx.order.findMany({
    where: {
      status: "PENDING",
      OR: [
        { claimedById: null },
        { claimedById: actor.userId },
        { claimedAt: null },
        { claimedAt: { lte: cutoff } },
      ],
    },
    orderBy: [{ priority: "desc" }, { orderedAt: "asc" }, { id: "asc" }],
    take: SUGGESTION_CANDIDATES,
    select: {
      id: true,
      number: true,
      version: true,
      orderedAt: true,
      items: { include: lineInclude, orderBy: { id: "asc" } },
    },
  });
  return orders
    .map(({ items, ...order }) => ({
      ...order,
      lines: items
        .filter(isWorkLine)
        .map((row) => ({ key: shelfKey(row), name: row.name, quantity: activeQuantity(row) })),
    }))
    .filter((order) => order.lines.length > 0);
}

export async function getBatchSuggestions(
  db: Db,
  actor: Actor,
  { now = new Date() }: SuggestionOptions = {},
): Promise<BatchSuggestions> {
  assertMayPick(actor);
  return db.$transaction(async (tx) => {
    const settings = await loadSettings(tx);
    const expiry = settings.claimExpiryMinutes;
    // A batch with nothing live left is closed on this read, as on any batch read, so it doesn't
    // block the cards: createBatch would close it anyway.
    const open = await tx.pickBatch.findFirst({
      where: { ownerId: actor.userId, closedAt: null },
      include: batchInclude,
    });
    const openBatch =
      open && !(await closeIfSpent(tx, open, expiry, now))
        ? { id: open.id, number: open.number }
        : null;

    const candidates = await listSuggestionCandidates(tx, actor, expiry, now);
    return {
      openBatch,
      suggestions: suggestBatches(candidates, {
        maxOrders: settings.pickBatchMaxOrders,
        count: settings.pickBatchSuggestionCount,
      }),
    };
  });
}
