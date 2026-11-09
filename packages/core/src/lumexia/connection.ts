import type { LumexiaConnectionResult } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import type { LumexiaClient } from "../adapters/lumexia/client";
import { isLumexiaError } from "../adapters/lumexia/errors";
import { createLumexiaClient, type LumexiaHttpOptions } from "../adapters/lumexia/http";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { getIntegrationConfig } from "../settings/integration";

/** `down` covers every failure, a refused key included: the floor keeps working either way. */
export type LumexiaHealth = "ok" | "unconfigured" | "down";

const PING_TIMEOUT_MS = 3_000;
const CACHE_MS = 30_000;

/**
 * The Lumexia client from Settings (`lumexiaBaseUrl` and `lumexiaApiKey`), or null until both are
 * set. With no client, linking is unavailable and captured lots stay unverified (SPEC-lumexia).
 */
export async function lumexiaClientFor(
  db: Db,
  options?: LumexiaHttpOptions,
): Promise<LumexiaClient | null> {
  const { lumexia } = await getIntegrationConfig(db);
  return lumexia ? createLumexiaClient(lumexia, options) : null;
}

let cached: { at: number; result: Promise<LumexiaHealth> } | null = null;

/** Forget the cached result (tests). */
export function resetLumexiaHealthCache(): void {
  cached = null;
}

/**
 * The `lumexia` health entry (SPEC-lumexia "Adapter", following SPEC-operations "Health"): a
 * `ping()` with a 3 s budget. The result, an in-flight ping included, is cached for 30 s so the
 * public endpoint can't be used to hammer Lumexia. Never throws, never says why or which host.
 */
export function lumexiaHealth(
  db: Db,
  {
    client = (d: Db) => lumexiaClientFor(d, { timeoutMs: PING_TIMEOUT_MS }),
    now = Date.now(),
    timeoutMs = PING_TIMEOUT_MS,
  }: {
    client?: (db: Db) => Promise<LumexiaClient | null>;
    now?: number;
    timeoutMs?: number;
  } = {},
): Promise<LumexiaHealth> {
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  const result = check(db, client, timeoutMs);
  cached = { at: now, result };
  return result;
}

async function check(
  db: Db,
  client: (db: Db) => Promise<LumexiaClient | null>,
  timeoutMs: number,
): Promise<LumexiaHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lumexia = await client(db);
    if (!lumexia) return "unconfigured";
    await Promise.race([
      lumexia.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settings → Lumexia → **Test connection**: the same three states as health, uncached, with the
 * reason when it isn't ok. Admin only (`lumexia.manage`).
 */
export async function testLumexiaConnection(
  db: Db,
  actor: Actor,
  connect: (db: Db) => Promise<LumexiaClient | null> = (d) => lumexiaClientFor(d),
): Promise<LumexiaConnectionResult> {
  assertCan(actor, "lumexia.manage");
  try {
    const client = await connect(db);
    if (!client) return { status: "unconfigured", messageKey: "errors.lumexia.unconfigured" };
    await client.ping();
    return { status: "ok" };
  } catch (error) {
    // A saved key that can't be decrypted is a settings problem worth showing here too.
    if (isLumexiaError(error) || error instanceof AppError) {
      return { status: "down", messageKey: error.messageKey };
    }
    throw error;
  }
}
