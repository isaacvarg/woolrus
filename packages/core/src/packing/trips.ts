import { PackCheck, type PackCheckStat, type Trip } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { type Actor, assertCan } from "../permissions";
import { lineInclude } from "../picking/service";
import { loadCheckSettings, toCheckPackage, unitOf } from "./check-inputs";
import { evaluateChecks } from "./checks";

// Saved trips (SPEC-packing A1, decision 20): when an order leaves Packing for QA its trips are
// written as they stood, so QA sees what the packer saw and a later settings change doesn't
// rewrite them. Going back to Packing deletes them. `transition` calls both, so every way in or
// out (completePacking, forceStatus, repack) does it in the move's own transaction.

export type PackageTrips = { packageId: string; number: number; trips: Trip[] };

/** Every live package's trips, evaluated now with the current settings, in package order. */
export async function evaluateOrderTrips(tx: DbTx, orderId: string): Promise<PackageTrips[]> {
  const [rows, packages, settings] = await Promise.all([
    tx.orderItem.findMany({ where: { orderId }, include: lineInclude }),
    tx.package.findMany({
      where: { orderId, discardedAt: null },
      include: { box: true, items: { select: { orderItemId: true, quantity: true } } },
      orderBy: { number: "asc" },
    }),
    loadCheckSettings(tx),
  ]);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return packages.map((pkg) => ({
    packageId: pkg.id,
    number: pkg.number,
    trips: evaluateChecks(
      toCheckPackage(pkg),
      pkg.items.flatMap((it) => {
        const row = rowById.get(it.orderItemId);
        return row ? [unitOf(row, it.quantity)] : [];
      }),
      settings,
    ),
  }));
}

/** The order's packages, discarded ones included: a repack can discard a package that tripped. */
const packagesOf = (orderId: string) => ({ package: { orderId } });

/**
 * Writes one row per WARN or BLOCK trip of the order's packages, replacing any left over (an
 * order put into Packing by hand never had its old rows cleared). Returns the trips it saved.
 */
export async function saveTrips(
  tx: DbTx,
  orderId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<PackageTrips[]> {
  await clearTrips(tx, orderId);
  const evaluated = await evaluateOrderTrips(tx, orderId);
  const data = evaluated.flatMap(({ packageId, trips }) =>
    trips.map((trip) => ({
      packageId,
      check: trip.check,
      mode: trip.mode,
      details: trip.details,
      createdAt: now,
    })),
  );
  if (data.length > 0) await tx.packageCheckTrip.createMany({ data });
  return evaluated.filter((p) => p.trips.length > 0);
}

/**
 * Deletes the order's saved trips and QA's box confirmations, as an order going back to Packing
 * starts over. Approvals stay.
 */
export async function clearTrips(tx: DbTx, orderId: string): Promise<void> {
  await tx.packageCheckTrip.deleteMany({ where: packagesOf(orderId) });
  await tx.package.updateMany({
    where: { orderId, boxConfirmedAt: { not: null } },
    data: { boxConfirmedAt: null, boxConfirmedById: null },
  });
}

export const PACK_CHECK_STATS_DAYS = 30;

/** Per check, the trips saved in the last 30 days and how many an approval let through. */
export async function packCheckStats(
  db: Db | DbTx,
  actor: Actor,
  { now = new Date() }: { now?: Date } = {},
): Promise<PackCheckStat[]> {
  assertCan(actor, "settings.manage");
  const since = new Date(now.getTime() - PACK_CHECK_STATS_DAYS * 24 * 60 * 60_000);
  const where = { createdAt: { gte: since } };
  const [all, approved] = await Promise.all([
    db.packageCheckTrip.groupBy({ by: ["check"], where, _count: { _all: true } }),
    db.packageCheckTrip.groupBy({
      by: ["check"],
      where: { ...where, approvalId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const count = (groups: typeof all, check: string) =>
    groups.find((g) => g.check === check)?._count._all ?? 0;
  return PackCheck.options.map((check) => ({
    check,
    trips: count(all, check),
    approved: count(approved, check),
  }));
}
