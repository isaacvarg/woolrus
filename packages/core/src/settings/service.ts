import {
  type AdminSettings,
  type PublicSettings,
  ShipFromAddress,
  StageSlaMinutes,
  type UpdateSettingsInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma, Settings } from "@woolrus/db";
import { recordAudit } from "../audit";
import { type Actor, assertCan } from "../permissions";

// One settings row (id 1) holds the warehouse's configuration (FR-SET-05). The seed creates it;
// reads create it too, so a fresh database never fails here.

const SETTINGS_ID = 1;

async function loadSettings(tx: DbTx): Promise<Settings> {
  return tx.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
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
    stageSlaMinutes: sla.success ? sla.data : {},
    weightDisplay: row.weightDisplay,
    piiRetentionDays: row.piiRetentionDays,
    qaMustDifferFromPacker: row.qaMustDifferFromPacker,
  };
}

export async function getSettings(db: Db, actor: Actor): Promise<AdminSettings> {
  assertCan(actor, "settings.manage");
  return toAdminSettings(await loadSettings(db));
}

/** Any signed-in user: the API's `authed` middleware is what requires the session. */
export async function getPublicSettings(db: Db, _actor: Actor): Promise<PublicSettings> {
  const { weightDisplay, stationIdleLockMinutes, stageSlaMinutes } = toAdminSettings(
    await loadSettings(db),
  );
  return { weightDisplay, stationIdleLockMinutes, stageSlaMinutes };
}

/** Partial update; the audit event holds before/after of the fields that actually changed. */
export async function updateSettings(
  db: Db,
  actor: Actor,
  patch: UpdateSettingsInput,
): Promise<AdminSettings> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = toAdminSettings(await loadSettings(tx));
    const changed = (Object.keys(patch) as (keyof UpdateSettingsInput)[]).filter(
      (key) =>
        patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(current[key]),
    );
    if (changed.length === 0) return current;

    const before = Object.fromEntries(changed.map((key) => [key, current[key]]));
    const after = Object.fromEntries(changed.map((key) => [key, patch[key]]));
    const updated = toAdminSettings(
      await tx.settings.update({ where: { id: SETTINGS_ID }, data: after }),
    );
    await recordAudit(tx, actor, {
      entityType: "Settings",
      entityId: String(SETTINGS_ID),
      action: "update",
      before: before as Prisma.InputJsonObject,
      after: after as Prisma.InputJsonObject,
    });
    return updated;
  });
}
