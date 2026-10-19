import type { Db } from "@woolrus/db";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { createStoreAdapter, type StoreHttpOptions } from "../adapters/woocommerce/http";
import { getIntegrationConfig } from "../settings/integration";
import { type SyncOrdersResult, syncOrders } from "./orders";

// The worker ticks `orders.sync` every minute and the interval is checked here at run time, so a
// changed `syncIntervalMinutes` takes effect on the next tick with no rescheduling (FR-SYNC-09).

/** `Settings.syncIntervalMinutes`' default, for a store whose settings were never saved. */
const DEFAULT_INTERVAL_MINUTES = 5;

/** True when `intervalMinutes` have passed since the last poll started (or none ever did). */
export function isPollDue(lastStart: Date | null, intervalMinutes: number, now: Date): boolean {
  if (!lastStart) return true;
  const elapsed = now.getTime() - lastStart.getTime();
  // A clock that moved back would otherwise hold polling off until it caught up.
  return elapsed < 0 || elapsed >= intervalMinutes * 60_000;
}

export type PollResult = SyncOrdersResult | { status: "alreadyRunning" } | { status: "notDue" };

/** A scheduled tick polls only when due; a manual run always polls. */
export async function pollIfDue(
  db: Db,
  store: StoreAdapter | null,
  { reason, now = new Date() }: { reason: "schedule" | "manual"; now?: Date },
): Promise<PollResult> {
  if (reason === "schedule") {
    // Any status counts, failed runs included, so a broken store is retried per interval, not per tick.
    const [settings, last] = await Promise.all([
      db.settings.findUnique({ where: { id: 1 }, select: { syncIntervalMinutes: true } }),
      db.syncRun.findFirst({
        where: { type: "ORDERS_POLL" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      }),
    ]);
    const interval = settings?.syncIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    if (!isPollDue(last?.startedAt ?? null, interval, now)) return { status: "notDue" };
  }
  return syncOrders(db, store, { type: "ORDERS_POLL", now });
}

/** The HTTP adapter for the configured store, or null when WooCommerce isn't set up yet. */
export async function configuredStore(
  db: Db,
  options?: StoreHttpOptions,
): Promise<StoreAdapter | null> {
  const { woocommerce } = await getIntegrationConfig(db);
  return woocommerce ? createStoreAdapter(woocommerce, options) : null;
}
