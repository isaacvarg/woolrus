import type { Db } from "@woolrus/db";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { configuredStore } from "./schedule";

export type WooHealth = "ok" | "fail" | "unconfigured";

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
    now = Date.now(),
    timeoutMs = PING_TIMEOUT_MS,
  }: {
    store?: (db: Db) => Promise<StoreAdapter | null>;
    now?: number;
    timeoutMs?: number;
  } = {},
): Promise<WooHealth> {
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  const result = check(db, store, timeoutMs);
  cached = { at: now, result };
  return result;
}

async function check(
  db: Db,
  store: (db: Db) => Promise<StoreAdapter | null>,
  timeoutMs: number,
): Promise<WooHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const adapter = await store(db);
    if (!adapter) return "unconfigured";
    await Promise.race([
      adapter.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return "ok";
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}
