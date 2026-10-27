import {
  type ClearProviderCredentialsInput,
  type ProviderAccount,
  providerCredentialFields,
  type SetProviderCredentialsInput,
  type SetProviderEnabledInput,
  type TestProviderInput,
  type TestProviderResult,
  type UpdateProviderConfigInput,
  type UpdateProviderConfigResult,
} from "@woolrus/contracts";
import type { Db, DbTx, ShippingProviderAccount } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { z } from "zod";
import {
  encryptProviderCredentials,
  readProviderCredentials,
} from "../adapters/shipping/credentials";
import { shippingErrorFromCause } from "../adapters/shipping/errors";
import {
  type ProviderId,
  providerIds,
  type ShippingProvider,
  withTimeout,
} from "../adapters/shipping/provider";
import {
  type AdapterFactories,
  buildShippingProvider,
  shippingAdapterAvailable,
  shippingAdapters,
} from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";

// Shipping provider accounts (SPEC-carriers "Provider accounts and settings"). Credentials are
// write-only: responses and audit events carry field names and `{ configured }`, never values.

/** A health check reuses a ping (or Test connection) this recent instead of calling again. */
const HEALTH_CACHE_MS = 5 * 60_000;

/**
 * How long a health ping may take. The image's HEALTHCHECK gives `/api/health` 5 s, and a slow
 * provider must degrade health, not get the container marked unhealthy.
 */
const HEALTH_PING_MS = 3_000;

const ENTITY = "ShippingProviderAccount";

const StoredConfig = z.object({ baseUrl: z.string().nullable().catch(null) }).catch({
  baseUrl: null,
});

/** The account row, created (disabled, no credentials) on first use. */
export async function loadAccount(
  tx: DbTx,
  provider: ProviderId,
): Promise<ShippingProviderAccount> {
  const row = await tx.shippingProviderAccount.findUnique({ where: { provider } });
  if (row) return row;
  // ON CONFLICT DO NOTHING, so two first reads at once don't fail on the unique provider.
  await tx.shippingProviderAccount.createMany({ data: [{ provider }], skipDuplicates: true });
  return tx.shippingProviderAccount.findUniqueOrThrow({ where: { provider } });
}

async function toProviderAccount(
  tx: DbTx,
  row: ShippingProviderAccount,
  adapters: AdapterFactories,
  carrierCount?: number,
): Promise<ProviderAccount> {
  const configured = row.credentialsEnc !== null;
  return {
    provider: row.provider,
    enabled: row.enabled,
    adapterAvailable: shippingAdapterAvailable(row.provider, adapters),
    // One blob holds every field, so they're set or unset together.
    credentials: Object.fromEntries(
      providerCredentialFields(row.provider).map((field) => [field, { configured }]),
    ),
    config: { baseUrl: StoredConfig.parse(row.config).baseUrl },
    lastCheckedAt: row.lastCheckedAt,
    lastErrorKey: row.lastErrorKey,
    carrierCount:
      carrierCount ?? (await tx.shippingCarrier.count({ where: { provider: row.provider } })),
  };
}

export async function listProviders(
  db: Db,
  actor: Actor,
  adapters: AdapterFactories = shippingAdapters,
): Promise<ProviderAccount[]> {
  assertCan(actor, "settings.manage");
  const rows = await Promise.all(providerIds.map((id) => loadAccount(db, id)));
  const counts = await db.shippingCarrier.groupBy({ by: ["provider"], _count: true });
  return Promise.all(
    rows.map((row) =>
      toProviderAccount(
        db,
        row,
        adapters,
        counts.find((c) => c.provider === row.provider)?._count ?? 0,
      ),
    ),
  );
}

/** Replaces the provider's credentials. Audited `secret.set` with the field names only. */
export async function setProviderCredentials(
  db: Db,
  actor: Actor,
  { provider, credentials }: SetProviderCredentialsInput,
): Promise<ProviderAccount> {
  assertCan(actor, "settings.manage");
  const credentialsEnc = encryptProviderCredentials(credentials);
  return db.$transaction(async (tx) => {
    await loadAccount(tx, provider);
    // The last test was of the old credentials.
    const row = await tx.shippingProviderAccount.update({
      where: { provider },
      data: { credentialsEnc, lastCheckedAt: null, lastErrorKey: null },
    });
    await recordAudit(tx, actor, {
      entityType: ENTITY,
      entityId: provider,
      action: "secret.set",
      after: { provider, fields: Object.keys(credentials) },
    });
    return toProviderAccount(tx, row, shippingAdapters);
  });
}

/** Clears the credentials and disables the provider: it can't be asked without them. */
export async function clearProviderCredentials(
  db: Db,
  actor: Actor,
  { provider }: ClearProviderCredentialsInput,
): Promise<ProviderAccount> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = await loadAccount(tx, provider);
    if (current.credentialsEnc === null) return toProviderAccount(tx, current, shippingAdapters);
    const row = await tx.shippingProviderAccount.update({
      where: { provider },
      data: { credentialsEnc: null, enabled: false, lastCheckedAt: null, lastErrorKey: null },
    });
    await recordAudit(tx, actor, {
      entityType: ENTITY,
      entityId: provider,
      action: "secret.clear",
      after: { provider, disabled: current.enabled },
    });
    return toProviderAccount(tx, row, shippingAdapters);
  });
}

const origin = (url: string | null) => (url === null ? null : new URL(url).origin);

/**
 * Non-secret config. A base URL moving to another origin (or removed) clears the credentials and
 * disables the provider in the same transaction, so they're never sent to a server they weren't
 * meant for (decisions 2026-10-15, as `updateSettings` does for Woo and Lumexia).
 */
export async function updateProviderConfig(
  db: Db,
  actor: Actor,
  { provider, baseUrl }: UpdateProviderConfigInput,
): Promise<UpdateProviderConfigResult> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = await loadAccount(tx, provider);
    const config = StoredConfig.parse(current.config);
    if (config.baseUrl === baseUrl) {
      return {
        ...(await toProviderAccount(tx, current, shippingAdapters)),
        credentialsCleared: false,
      };
    }
    const moved = config.baseUrl !== null && origin(config.baseUrl) !== origin(baseUrl);
    const cleared = moved && current.credentialsEnc !== null;
    const row = await tx.shippingProviderAccount.update({
      where: { provider },
      data: {
        config: { ...(current.config as object), baseUrl },
        ...(cleared
          ? { credentialsEnc: null, enabled: false, lastCheckedAt: null, lastErrorKey: null }
          : {}),
      },
    });
    await recordAudit(tx, actor, {
      entityType: ENTITY,
      entityId: provider,
      action: "update",
      before: { baseUrl: config.baseUrl },
      after: { baseUrl },
    });
    if (cleared) {
      await recordAudit(tx, actor, {
        entityType: ENTITY,
        entityId: provider,
        action: "secret.clear",
        after: { provider, reason: "urlChanged", disabled: current.enabled },
      });
    }
    return {
      ...(await toProviderAccount(tx, row, shippingAdapters)),
      credentialsCleared: cleared,
    };
  });
}

/** The adapter for an account, or why there's none. */
export function providerFor(
  row: ShippingProviderAccount,
  adapters: AdapterFactories,
): ShippingProvider {
  const credentials = readProviderCredentials(row.provider, row.credentialsEnc);
  if (credentials === null) {
    throw new AppError("BAD_REQUEST", "errors.carriers.credentialsMissing");
  }
  if (!shippingAdapterAvailable(row.provider, adapters)) {
    throw new AppError("BAD_REQUEST", "errors.carriers.providerNotAvailable");
  }
  const provider = buildShippingProvider(row.provider, credentials, row.config, adapters);
  // Stored credentials that no longer fit the provider's fields count as missing.
  if (!provider) throw new AppError("BAD_REQUEST", "errors.carriers.credentialsMissing");
  return provider;
}

/** Null when the provider accepts the credentials, else the error key to show. */
async function ping(provider: ShippingProvider, timeoutMs?: number): Promise<ErrorCode | null> {
  try {
    await (timeoutMs === undefined ? provider.ping() : withTimeout(provider.ping(), timeoutMs));
    return null;
  } catch (error) {
    return shippingErrorFromCause("ping", error).messageKey;
  }
}

/** Test connection with the saved credentials. A refused ping is a result, stored for the card. */
export async function testProvider(
  db: Db,
  actor: Actor,
  { provider }: TestProviderInput,
  adapters: AdapterFactories = shippingAdapters,
): Promise<TestProviderResult> {
  assertCan(actor, "settings.manage");
  const current = await loadAccount(db, provider);
  const messageKey = await ping(providerFor(current, adapters));
  const row = await db.shippingProviderAccount.update({
    where: { provider },
    data: { lastCheckedAt: new Date(), lastErrorKey: messageKey },
  });
  return {
    ok: messageKey === null,
    messageKey,
    account: await toProviderAccount(db, row, adapters),
  };
}

/**
 * Enabling needs credentials, an adapter in this build and a passing ping in the same call;
 * refused, it changes nothing. Disabling always works.
 */
export async function setProviderEnabled(
  db: Db,
  actor: Actor,
  { provider, enabled }: SetProviderEnabledInput,
  adapters: AdapterFactories = shippingAdapters,
): Promise<ProviderAccount> {
  assertCan(actor, "settings.manage");
  const current = await loadAccount(db, provider);
  if (current.enabled === enabled) return toProviderAccount(db, current, adapters);
  if (enabled && (await ping(providerFor(current, adapters))) !== null) {
    throw new AppError("BAD_REQUEST", "errors.carriers.providerUnreachable");
  }
  return db.$transaction(async (tx) => {
    // Only if nothing changed since the ping: other credentials weren't the ones it accepted.
    const { count } = await tx.shippingProviderAccount.updateMany({
      where: { provider, enabled: current.enabled, credentialsEnc: current.credentialsEnc },
      data: { enabled },
    });
    if (count === 0) throw new AppError("CONFLICT", "errors.conflict");
    await recordAudit(tx, actor, {
      entityType: ENTITY,
      entityId: provider,
      action: enabled ? "enable" : "disable",
    });
    return toProviderAccount(tx, await loadAccount(tx, provider), adapters);
  });
}

export type ProviderHealth = "disabled" | "unconfigured" | "ok" | "fail";

/**
 * One entry per provider for `/api/health` (NFR-OPS-02). An enabled provider is pinged at most
 * every 5 minutes (the result is stored like Test connection's); one failing makes health degraded,
 * not down. No actor: the health endpoint is unauthenticated and returns no details.
 */
export async function shippingProviderHealth(
  db: Db,
  adapters: AdapterFactories = shippingAdapters,
  now = new Date(),
  pingTimeoutMs = HEALTH_PING_MS,
): Promise<{ providers: Record<ProviderId, ProviderHealth>; degraded: boolean }> {
  const rows = await db.shippingProviderAccount.findMany();
  const entries = await Promise.all(
    providerIds.map(async (id): Promise<[ProviderId, ProviderHealth]> => {
      const row = rows.find((r) => r.provider === id);
      let credentials: unknown;
      try {
        credentials = readProviderCredentials(id, row?.credentialsEnc ?? null);
      } catch {
        credentials = undefined; // stored but unreadable (wrong or missing key)
      }
      if (credentials === null) return [id, "unconfigured"];
      if (!row?.enabled) return [id, "disabled"];
      if (row.lastCheckedAt && now.getTime() - row.lastCheckedAt.getTime() < HEALTH_CACHE_MS) {
        return [id, row.lastErrorKey === null ? "ok" : "fail"];
      }
      if (credentials === undefined) return [id, "fail"];
      let provider: ShippingProvider;
      try {
        provider = providerFor(row, adapters);
      } catch {
        return [id, "fail"];
      }
      const messageKey = await ping(provider, pingTimeoutMs);
      await db.shippingProviderAccount.update({
        where: { provider: id },
        data: { lastCheckedAt: now, lastErrorKey: messageKey },
      });
      return [id, messageKey === null ? "ok" : "fail"];
    }),
  );
  const providers = Object.fromEntries(entries) as Record<ProviderId, ProviderHealth>;
  return { providers, degraded: Object.values(providers).includes("fail") };
}
