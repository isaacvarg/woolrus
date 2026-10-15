import type { DbTx } from "@woolrus/db";
import { loadSettings } from "../settings/service";

// A claim is Order.claimedById + claimedAt. Expiry is lazy: a claim older than
// Settings.claimExpiryMinutes reads as absent, and nothing clears it.

export async function claimExpiryMinutes(tx: DbTx): Promise<number> {
  return (await loadSettings(tx)).claimExpiryMinutes;
}

export function isClaimLive(
  order: { claimedById: string | null; claimedAt: Date | null },
  expiryMinutes: number,
  now: Date,
): boolean {
  return (
    order.claimedById !== null &&
    order.claimedAt !== null &&
    order.claimedAt.getTime() + expiryMinutes * 60_000 > now.getTime()
  );
}
