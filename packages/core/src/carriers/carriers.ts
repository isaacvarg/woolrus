import type {
  ProviderShippingConfig,
  SetShippingEnabledInput,
  ShippingCarrierConfig,
  ShippingServiceConfig,
  SyncCarriersInput,
  SyncCarriersResult,
} from "@woolrus/contracts";
import type { CarrierService, Db, Prisma, ShippingCarrier } from "@woolrus/db";
import { ShippingError } from "../adapters/shipping/errors";
import { type ProviderCarrier, type ProviderId, providerIds } from "../adapters/shipping/provider";
import { type AdapterFactories, shippingAdapters } from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { loadAccount, providerFor } from "./providers";

// Carrier and service sync and toggles (SPEC-carriers "Provider accounts and settings"). Synced
// carriers and services arrive off; ones the provider stops listing get `missingSince` and are
// never sent again, but stay (rates, labels and manifests point at them).

const ACCOUNT = "ShippingProviderAccount";

/** Pulls the provider's carriers and services. Audited `sync` with the counts. */
export async function syncCarriers(
  db: Db,
  actor: Actor,
  { provider }: SyncCarriersInput,
  adapters: AdapterFactories = shippingAdapters,
): Promise<SyncCarriersResult> {
  assertCan(actor, "settings.manage");
  const account = await loadAccount(db, provider);
  if (!account.enabled) throw new AppError("BAD_REQUEST", "errors.carriers.providerOff");
  let listed: ProviderCarrier[];
  try {
    listed = await providerFor(account, adapters).listCarriers();
  } catch (error) {
    if (error instanceof ShippingError) throw new AppError("BAD_REQUEST", error.messageKey);
    throw error;
  }

  return db.$transaction(async (tx) => {
    const now = new Date();
    const existing = await tx.shippingCarrier.findMany({
      where: { provider },
      include: { services: true },
    });
    const result = { carriersAdded: 0, servicesAdded: 0, carriersMissing: 0, servicesMissing: 0 };
    const seenServices = new Set<string>();

    for (const listedCarrier of listed) {
      const before = existing.find((c) => c.externalId === listedCarrier.externalId);
      if (!before) result.carriersAdded++;
      // Upserts, so a sync racing another doesn't fail on the unique keys.
      const carrier = await tx.shippingCarrier.upsert({
        where: { provider_externalId: { provider, externalId: listedCarrier.externalId } },
        create: {
          provider,
          externalId: listedCarrier.externalId,
          code: listedCarrier.externalId,
          name: listedCarrier.name,
        },
        update: { name: listedCarrier.name, missingSince: null },
      });
      for (const listedService of listedCarrier.services) {
        if (!before?.services.some((s) => s.code === listedService.code)) result.servicesAdded++;
        const fields = {
          name: listedService.name,
          domestic: listedService.domestic,
          international: listedService.international,
          providerData: listedService.providerData as Prisma.InputJsonObject,
        };
        const service = await tx.carrierService.upsert({
          where: { carrierId_code: { carrierId: carrier.id, code: listedService.code } },
          create: { carrierId: carrier.id, code: listedService.code, ...fields },
          update: { ...fields, missingSince: null },
        });
        seenServices.add(service.id);
      }
    }

    const listedIds = new Set(listed.map((c) => c.externalId));
    const goneCarriers = existing.filter(
      (c) => !listedIds.has(c.externalId) && c.missingSince === null,
    );
    const goneServices = existing
      .flatMap((c) => c.services)
      .filter((s) => !seenServices.has(s.id) && s.missingSince === null);
    result.carriersMissing = goneCarriers.length;
    result.servicesMissing = goneServices.length;
    await tx.shippingCarrier.updateMany({
      where: { id: { in: goneCarriers.map((c) => c.id) } },
      data: { missingSince: now },
    });
    await tx.carrierService.updateMany({
      where: { id: { in: goneServices.map((s) => s.id) } },
      data: { missingSince: now },
    });

    await recordAudit(tx, actor, {
      entityType: ACCOUNT,
      entityId: provider,
      action: "sync",
      after: { provider, ...result },
    });
    return result;
  });
}

function toServiceConfig(row: CarrierService): ShippingServiceConfig {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    domestic: row.domestic,
    international: row.international,
    enabled: row.enabled,
    missing: row.missingSince !== null,
  };
}

function toCarrierConfig(row: ShippingCarrier & { services: CarrierService[] }) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    missing: row.missingSince !== null,
    services: row.services.map(toServiceConfig),
  } satisfies ShippingCarrierConfig;
}

const byName = { orderBy: { name: "asc" } } as const;

/** Every provider's carriers and services, with when each was last synced. */
export async function listShippingConfig(db: Db, actor: Actor): Promise<ProviderShippingConfig[]> {
  assertCan(actor, "settings.manage");
  const [carriers, syncs] = await Promise.all([
    db.shippingCarrier.findMany({ ...byName, include: { services: byName } }),
    db.auditEvent.groupBy({
      by: ["entityId"],
      where: { entityType: ACCOUNT, action: "sync" },
      _max: { at: true },
    }),
  ]);
  return providerIds.map((provider) => ({
    provider,
    lastSyncedAt: syncs.find((s) => s.entityId === provider)?._max.at ?? null,
    carriers: carriers.filter((c) => c.provider === provider).map(toCarrierConfig),
  }));
}

/** A carrier's switch. Its services keep theirs: only a service and its carrier both on is used. */
export async function setCarrierEnabled(
  db: Db,
  actor: Actor,
  { id, enabled }: SetShippingEnabledInput,
): Promise<ShippingCarrierConfig> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = await tx.shippingCarrier.findUnique({ where: { id } });
    if (!current) throw notFound();
    if (current.enabled !== enabled) {
      await tx.shippingCarrier.update({ where: { id }, data: { enabled } });
      await recordAudit(tx, actor, {
        entityType: "ShippingCarrier",
        entityId: id,
        action: enabled ? "enable" : "disable",
        after: { provider: current.provider, name: current.name },
      });
    }
    return toCarrierConfig(
      await tx.shippingCarrier.findUniqueOrThrow({ where: { id }, include: { services: byName } }),
    );
  });
}

export async function setServiceEnabled(
  db: Db,
  actor: Actor,
  { id, enabled }: SetShippingEnabledInput,
): Promise<ShippingServiceConfig> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = await tx.carrierService.findUnique({ where: { id } });
    if (!current) throw notFound();
    if (current.enabled === enabled) return toServiceConfig(current);
    const row = await tx.carrierService.update({ where: { id }, data: { enabled } });
    await recordAudit(tx, actor, {
      entityType: "CarrierService",
      entityId: id,
      action: enabled ? "enable" : "disable",
      after: { carrierId: current.carrierId, code: current.code },
    });
    return toServiceConfig(row);
  });
}

/**
 * The services a provider may be asked to rate: the service and its carrier both on, and both
 * still listed by the provider. Rate fetches send only these (FR-SHIP-02).
 */
export function listUsableServices(
  db: Db,
  provider: ProviderId,
): Promise<(CarrierService & { carrier: ShippingCarrier })[]> {
  return db.carrierService.findMany({
    where: {
      enabled: true,
      missingSince: null,
      carrier: { provider, enabled: true, missingSince: null },
    },
    include: { carrier: true },
    orderBy: [{ carrier: { name: "asc" } }, { name: "asc" }],
  });
}
