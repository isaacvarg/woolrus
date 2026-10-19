import {
  type AdminSettings,
  type ClearSecretInput,
  type PublicSettings,
  SecretName,
  type SetSecretInput,
  ShipFromAddress,
  StageSlaMinutes,
  type UpdateSettingsInput,
  type UpdateSettingsResult,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma, Settings } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { encryptSecret } from "./crypto";
import { encryptionKey } from "./env";

// One settings row (id 1) holds the warehouse's configuration (FR-SET-05). The seed creates it;
// reads create it too, so a fresh database never fails here.

const SETTINGS_ID = 1;

/** The column holding each secret's ciphertext. */
const secretColumns = {
  wooConsumerKey: "wooConsumerKeyEnc",
  wooConsumerSecret: "wooConsumerSecretEnc",
  wooWebhookSecret: "wooWebhookSecretEnc",
  shipstationApiKey: "shipstationApiKeyEnc",
  lumexiaApiKey: "lumexiaApiKeyEnc",
} as const satisfies Record<SecretName, keyof Settings>;

/** Each integration URL and the secrets that only make sense for the server it points at. */
const urlSecrets = {
  wooStoreUrl: ["wooConsumerKey", "wooConsumerSecret", "wooWebhookSecret"],
  lumexiaBaseUrl: ["lumexiaApiKey"],
} as const satisfies Partial<Record<keyof UpdateSettingsInput, readonly SecretName[]>>;

const origin = (url: string | null) => (url === null ? null : new URL(url).origin);

/**
 * The URLs in `patch` that point somewhere else than before: a different origin (scheme, host,
 * port), or removed. Setting a URL where there was none isn't a move: keys saved before it were
 * entered for whatever URL comes first.
 */
function movedUrls(current: Settings, patch: UpdateSettingsInput) {
  return (Object.keys(urlSecrets) as (keyof typeof urlSecrets)[]).filter((field) => {
    const next = patch[field];
    return next !== undefined && current[field] !== null && origin(current[field]) !== origin(next);
  });
}

/** The settings row, created with defaults on first use. */
export async function loadSettings(tx: DbTx): Promise<Settings> {
  const row = await tx.settings.findUnique({ where: { id: SETTINGS_ID } });
  if (row) return row;
  // Not Prisma's upsert: it reads then inserts, so two first uses at once hit the primary key, and
  // inside a transaction that error can't be recovered from. ON CONFLICT lets the loser just read.
  await tx.$executeRaw`INSERT INTO settings (id, updated_at) VALUES (${SETTINGS_ID}, now())
    ON CONFLICT (id) DO NOTHING`;
  return tx.settings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
}

/** Stored JSON that no longer fits the contract (older shape, hand edits) reads as unset. */
function toAdminSettings(row: Settings): AdminSettings {
  const shipFrom = ShipFromAddress.safeParse(row.shipFromAddress);
  const sla = StageSlaMinutes.safeParse(row.stageSlaMinutes);
  return {
    shipFromAddress: shipFrom.success ? shipFrom.data : null,
    wooStoreUrl: row.wooStoreUrl,
    lumexiaBaseUrl: row.lumexiaBaseUrl,
    syncIntervalMinutes: row.syncIntervalMinutes,
    stationIdleLockMinutes: row.stationIdleLockMinutes,
    claimExpiryMinutes: row.claimExpiryMinutes,
    stageSlaMinutes: sla.success ? sla.data : {},
    weightDisplay: row.weightDisplay,
    piiRetentionDays: row.piiRetentionDays,
    qaMustDifferFromPacker: row.qaMustDifferFromPacker,
    // Status comes from the column alone, so reads never decrypt and work without a key.
    secrets: Object.fromEntries(
      SecretName.options.map((name) => [name, { configured: row[secretColumns[name]] !== null }]),
    ) as AdminSettings["secrets"],
  };
}

export async function getSettings(db: Db, actor: Actor): Promise<AdminSettings> {
  assertCan(actor, "settings.manage");
  return toAdminSettings(await loadSettings(db));
}

/** Any signed-in user: the API's `authed` middleware is what requires the session. */
export async function getPublicSettings(db: Db, _actor: Actor): Promise<PublicSettings> {
  const { weightDisplay, stationIdleLockMinutes, claimExpiryMinutes, stageSlaMinutes } =
    toAdminSettings(await loadSettings(db));
  return { weightDisplay, stationIdleLockMinutes, claimExpiryMinutes, stageSlaMinutes };
}

/**
 * Partial update; the audit event holds before/after of the fields that actually changed. Moving an
 * integration URL to another origin clears that integration's secrets in the same transaction, so
 * a changed URL can't receive keys meant for the old server (decisions 2026-10-15).
 */
export async function updateSettings(
  db: Db,
  actor: Actor,
  patch: UpdateSettingsInput,
): Promise<UpdateSettingsResult> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const row = await loadSettings(tx);
    const current = toAdminSettings(row);
    const changed = (Object.keys(patch) as (keyof UpdateSettingsInput)[]).filter(
      (key) =>
        patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(current[key]),
    );
    if (changed.length === 0) return { ...current, clearedSecrets: [] };

    const cleared = movedUrls(row, patch)
      .flatMap((field) => urlSecrets[field])
      .filter((name) => row[secretColumns[name]] !== null);
    const before = Object.fromEntries(changed.map((key) => [key, current[key]]));
    const after = Object.fromEntries(changed.map((key) => [key, patch[key]]));
    const updated = toAdminSettings(
      await tx.settings.update({
        where: { id: SETTINGS_ID },
        data: { ...after, ...Object.fromEntries(cleared.map((n) => [secretColumns[n], null])) },
      }),
    );
    await recordAudit(tx, actor, {
      entityType: "Settings",
      entityId: String(SETTINGS_ID),
      action: "update",
      before: before as Prisma.InputJsonObject,
      after: after as Prisma.InputJsonObject,
    });
    for (const secret of cleared) {
      await recordAudit(tx, actor, {
        entityType: "Settings",
        entityId: String(SETTINGS_ID),
        action: "secret.clear",
        after: { secret, reason: "urlChanged" },
      });
    }
    return { ...updated, clearedSecrets: cleared };
  });
}

/** Encrypts and stores a secret. Audited by name only: never the value or anything derived from it. */
export async function setSecret(
  db: Db,
  actor: Actor,
  { name, value }: SetSecretInput,
): Promise<AdminSettings> {
  assertCan(actor, "settings.manage");
  const key = encryptionKey();
  if (!key) throw new AppError("BAD_REQUEST", "errors.settings.encryptionKeyMissing");
  return db.$transaction(async (tx) => {
    await loadSettings(tx);
    const row = await tx.settings.update({
      where: { id: SETTINGS_ID },
      data: { [secretColumns[name]]: encryptSecret(value, key) },
    });
    await recordAudit(tx, actor, {
      entityType: "Settings",
      entityId: String(SETTINGS_ID),
      action: "secret.set",
      after: { secret: name },
    });
    return toAdminSettings(row);
  });
}

export async function clearSecret(
  db: Db,
  actor: Actor,
  { name }: ClearSecretInput,
): Promise<AdminSettings> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = await loadSettings(tx);
    if (current[secretColumns[name]] === null) return toAdminSettings(current);
    const row = await tx.settings.update({
      where: { id: SETTINGS_ID },
      data: { [secretColumns[name]]: null },
    });
    await recordAudit(tx, actor, {
      entityType: "Settings",
      entityId: String(SETTINGS_ID),
      action: "secret.clear",
      after: { secret: name },
    });
    return toAdminSettings(row);
  });
}
