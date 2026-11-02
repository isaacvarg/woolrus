import type { Db } from "@woolrus/db";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { loadSettings } from "../settings/service";
import { configuredStore } from "./schedule";

/** `trackingUnavailable`: the switch is on but the store lacks the AST plugin (degraded, not down). */
export type WooHealth = "ok" | "fail" | "unconfigured" | "trackingUnavailable";

const PING_TIMEOUT_MS = 3_000;
const CACHE_MS = 30_000;

let cached: { at: number; result: Promise<WooHealth> } | null = null;

/** Forget the cached result (tests). */
export function resetWooHealthCache(): void {
  cached = null;
}

/**
 * The `woocommerce` health entry (SPEC-operations "Health"): pings the store with a 3 s timeout.
 * The result, including an in-flight ping, is cached in memory for 30 s, so the public endpoint
 * can't be used to hammer the store. Never throws and never carries an error message or host.
 */
export function woocommerceHealth(
  db: Db,
  {
    store = (d: Db) => configuredStore(d, { retries: 0, timeoutMs: PING_TIMEOUT_MS }),
    trackingEnabled = async (d: Db) => (await loadSettings(d)).wooTrackingEnabled,
    now = Date.now(),
    timeoutMs = PING_TIMEOUT_MS,
  }: {
    store?: (db: Db) => Promise<StoreAdapter | null>;
    trackingEnabled?: (db: Db) => Promise<boolean>;
    now?: number;
    timeoutMs?: number;
  } = {},
): Promise<WooHealth> {
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  const result = check(db, store, trackingEnabled, timeoutMs);
  cached = { at: now, result };
  return result;
}

async function check(
  db: Db,
  store: (db: Db) => Promise<StoreAdapter | null>,
  trackingEnabled: (db: Db) => Promise<boolean>,
  timeoutMs: number,
): Promise<WooHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: WooHealth = "ok";
  try {
    const adapter = await store(db);
    if (!adapter) return "unconfigured";
    await Promise.race([
      probe(db, adapter, trackingEnabled),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]).then((health) => (result = health));
    return result;
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

/** The store answers; with the tracking switch on, it must also have AST's route. */
async function probe(
  db: Db,
  adapter: StoreAdapter,
  trackingEnabled: (db: Db) => Promise<boolean>,
): Promise<WooHealth> {
  await adapter.ping();
  if ((await trackingEnabled(db)) && !(await adapter.hasShipmentTracking())) {
    return "trackingUnavailable";
  }
  return "ok";
}
