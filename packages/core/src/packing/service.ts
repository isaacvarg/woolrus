import {
  type AddPackageInput,
  MAX_PACKAGE_WEIGHT_OZ,
  MAX_PACKAGES_PER_ORDER,
  type PackageBoxInput,
  type PackageIdInput,
  type PackResult,
  type PackUnitsInput,
  type ScanIntoPackageInput,
  type SetPackageBoxInput,
  type SetWeightInput,
} from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { type Actor, assertCan, can } from "../permissions";
import { normalizeCode } from "../picking/codes";
import { matchingLines, notOnOrder } from "../picking/scan";
import { activeQuantity, isWorkLine, type LineRow, lineInclude } from "../picking/service";
import { toNumber } from "../units";
import { claimExpiryMinutes, holdsClaim, isClaimLive, touchClaim } from "../workflow/claims";
import { type LockedOrder, lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import {
  isPhysical,
  type PackageRow,
  type PackOptions,
  packageInclude,
  packResult,
} from "./queries";

// Package operations (SPEC-packing "Package rules"). Only the claim holder writes an order's
// packages, and the order row lock orders those writes against transitions. So, like pick writes,
// they don't bump Order.version: a burst of optimistic taps would otherwise make the packer's own
// completePack fail as stale.

/** Locks the order and checks it is in Packing under the actor's live claim. Run inside a transaction. */
export async function lockForPacking(
  tx: DbTx,
  actor: Actor,
  orderId: string,
  now: Date,
): Promise<LockedOrder> {
  // Settings before the order lock: the lock order workflow uses everywhere.
  const expiry = await claimExpiryMinutes(tx);
  const order = await lockOrder(tx, orderId);
  if (order.status !== "PACKING") throw new AppError("CONFLICT", "errors.packing.notPacking");
  if (!isClaimLive(order, expiry, now) || !holdsClaim(actor, order.claimedById)) {
    throw new AppError("CONFLICT", "errors.workflow.claimRequired");
  }
  return order;
}

/** What an audit event records about a package: its box, weight and units per line. */
const snapshot = (pkg: PackageRow) => ({
  number: pkg.number,
  boxId: pkg.boxId,
  lengthIn: toNumber(pkg.lengthIn),
  widthIn: toNumber(pkg.widthIn),
  heightIn: toNumber(pkg.heightIn),
  weightOz: toNumber(pkg.weightOz),
  overrideReason: pkg.weightOverrideReason,
  weightStale: pkg.weightStale,
  items: pkg.items.map((it) => ({ orderItemId: it.orderItemId, quantity: it.quantity })),
});

const reload = (tx: DbTx, packageId: string) =>
  tx.package.findUniqueOrThrow({ where: { id: packageId }, include: packageInclude });

/** The box a package is given: its columns, and the max weight that box allows. */
async function boxColumns(tx: DbTx, box: PackageBoxInput) {
  if ("boxId" in box) {
    // Held to commit, so an archive can't land between this read and the package write.
    await tx.$queryRaw`SELECT id FROM boxes WHERE id = ${box.boxId}::uuid FOR SHARE`;
    const found = await tx.box.findUnique({ where: { id: box.boxId } });
    if (!found) throw notFound();
    if (found.archivedAt) throw new AppError("CONFLICT", "errors.packing.boxArchived");
    return {
      columns: { boxId: found.id, lengthIn: null, widthIn: null, heightIn: null },
      maxWeightOz: toNumber(found.maxWeightOz),
    };
  }
  // Custom dimensions are outer dimensions and have no max weight.
  const { lengthIn, widthIn, heightIn } = box;
  return { columns: { boxId: null, lengthIn, widthIn, heightIn }, maxWeightOz: null };
}

/** Loads a package and locks its order for packing; the package must belong to that order. */
async function lockPackage(tx: DbTx, actor: Actor, packageId: string, now: Date) {
  const ref = await tx.package.findUnique({ where: { id: packageId }, select: { orderId: true } });
  if (!ref) throw notFound();
  const order = await lockForPacking(tx, actor, ref.orderId, now);
  // Read after the lock, so a concurrent delete or renumber can't slip in between.
  const pkg = await tx.package.findUnique({ where: { id: packageId }, include: packageInclude });
  if (!pkg) throw notFound();
  return { order, pkg };
}

/**
 * Rates fetched for the package no longer fit it: they go, and a package that had some says it's
 * `STALE`, so QA sees Refresh rates (SPEC-carriers "Rate fetch").
 */
async function dropRates(tx: DbTx, packageId: string) {
  await tx.shippingRate.deleteMany({ where: { packageId } });
  await tx.package.updateMany({
    where: { id: packageId, ratesStatus: { not: "NONE" } },
    data: { ratesStatus: "STALE" },
  });
}

/**
 * The package's contents or box changed: rates were fetched for the old one, and a weight read
 * before the change is kept but flagged to re-weigh or confirm (SPEC-packing decision 5). QA
 * verified the old contents, so a contents change clears it; a box change doesn't. Labels are
 * never touched.
 */
export async function invalidate(tx: DbTx, packageId: string, contentsChanged: boolean) {
  await dropRates(tx, packageId);
  await tx.package.updateMany({
    where: { id: packageId, weightOz: { not: null } },
    data: { weightStale: true },
  });
  if (contentsChanged) {
    await tx.packageItem.updateMany({
      where: { packageId },
      data: { qaVerifiedQuantity: 0, qaVerifiedAt: null, qaVerifiedById: null },
    });
  }
}

/**
 * What every package write ends with: one audit event with the package before (when it existed)
 * and after (unless it was deleted), the claim refresh and the order_changed notify.
 */
async function finish(
  tx: DbTx,
  actor: Actor,
  order: LockedOrder,
  op: string,
  {
    packageId,
    before,
    deleted = false,
  }: { packageId: string; before?: PackageRow; deleted?: boolean },
  now: Date,
): Promise<PackResult> {
  const after = deleted ? undefined : await reload(tx, packageId);
  // A rate fetch still running was asked for the packages as they were: it now writes nothing.
  await tx.order.update({ where: { id: order.id }, data: { rateGeneration: { increment: 1 } } });
  await recordAudit(tx, actor, {
    entityType: "Package",
    entityId: packageId,
    action: `package.${op}`,
    before: before && snapshot(before),
    after: after && snapshot(after),
    at: now,
  });
  await touchClaim(tx, actor, order.id, { now });
  await notifyOrderChanged(tx, { id: order.id, status: order.status });
  return packResult(tx, order.id);
}

const invalid = (field: string, key: "errors.field.tooBig" | "errors.field.tooSmall") =>
  new AppError("BAD_REQUEST", "errors.validation", { [field]: key });

/** Adds a package after the last one. Idempotent on the key. */
export async function addPackage(
  db: Db,
  actor: Actor,
  { orderId, box, idempotencyKey }: AddPackageInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    // A replay is answered before the checks, which may no longer pass (the order moved on), but
    // only for the order the key was used for: another order's pack data isn't this key's to read.
    const replay = await storedResult<{ id: string; orderId: string }>(
      tx,
      idempotencyKey,
      "packing.addPackage",
      actor,
    );
    if (replay) {
      if (replay.orderId !== orderId) throw new AppError("CONFLICT", "errors.conflict");
      return packResult(tx, orderId);
    }
    const order = await lockForPacking(tx, actor, orderId, now);
    const { columns } = await boxColumns(tx, box);
    const created = await withIdempotency(
      tx,
      idempotencyKey,
      "packing.addPackage",
      actor,
      async () => {
        const { _count, _max } = await tx.package.aggregate({
          where: { orderId },
          _count: { _all: true },
          _max: { number: true },
        });
        if (_count._all >= MAX_PACKAGES_PER_ORDER) {
          throw new AppError("CONFLICT", "errors.packing.tooManyPackages", undefined, {
            params: { max: MAX_PACKAGES_PER_ORDER },
          });
        }
        const pkg = await tx.package.create({
          data: { orderId, number: (_max.number ?? 0) + 1, ...columns },
        });
        return { id: pkg.id, orderId };
      },
    );
    return finish(tx, actor, order, "add", { packageId: created.id }, now);
  });
}

/**
 * Replaces a package's box or custom dimensions. A reason for a weight above the old box's max
 * goes when the new box takes the weight without one.
 */
export async function setPackageBox(
  db: Db,
  actor: Actor,
  { packageId, box }: SetPackageBoxInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    const { columns, maxWeightOz } = await boxColumns(tx, box);
    // Decimals from the row against plain numbers from the request.
    const same = (a: unknown, b: unknown) =>
      (a == null ? null : Number(a)) === (b == null ? null : Number(b));
    // The same box again changes nothing, so it deletes no rates and flags no weight.
    if (
      pkg.boxId === columns.boxId &&
      same(pkg.lengthIn, columns.lengthIn) &&
      same(pkg.widthIn, columns.widthIn) &&
      same(pkg.heightIn, columns.heightIn)
    ) {
      return packResult(tx, order.id);
    }
    const weightOz = toNumber(pkg.weightOz);
    const withinMax = weightOz === null || maxWeightOz === null || weightOz <= maxWeightOz;
    await tx.package.update({
      where: { id: packageId },
      data: { ...columns, ...(withinMax ? { weightOverrideReason: null } : {}) },
    });
    await invalidate(tx, packageId, false);
    return finish(tx, actor, order, "setBox", { packageId, before: pkg }, now);
  });
}

/**
 * Deletes a package; its units return to Unassigned and later packages renumber so numbers stay
 * 1…n. A package any label references (even a voided one) can't go: empty it instead.
 */
export async function deletePackage(
  db: Db,
  actor: Actor,
  { packageId }: PackageIdInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    if ((await tx.shippingLabel.count({ where: { packageId } })) > 0) {
      throw new AppError("CONFLICT", "errors.packing.packageHasLabels");
    }
    await tx.package.delete({ where: { id: packageId } });
    // One at a time, lowest first: each takes the number just freed (the unique index is per row).
    const later = await tx.package.findMany({
      where: { orderId: order.id, number: { gt: pkg.number } },
      orderBy: { number: "asc" },
      select: { id: true, number: true },
    });
    for (const p of later) {
      await tx.package.update({ where: { id: p.id }, data: { number: p.number - 1 } });
    }
    return finish(tx, actor, order, "delete", { packageId, before: pkg, deleted: true }, now);
  });
}

/** Units of each of the order's lines that no package holds yet. */
async function unassignedByLine(tx: DbTx, orderId: string) {
  const rows = await tx.orderItem.findMany({ where: { orderId }, include: lineInclude });
  const packed = await tx.packageItem.groupBy({
    by: ["orderItemId"],
    where: { package: { orderId } },
    _sum: { quantity: true },
  });
  const inBoxes = new Map(packed.map((g) => [g.orderItemId, g._sum.quantity ?? 0]));
  return rows.map((row) => ({
    row,
    unassigned: Math.max(activeQuantity(row) - (inBoxes.get(row.id) ?? 0), 0),
  }));
}

async function addUnits(
  tx: DbTx,
  actor: Actor,
  packageId: string,
  orderItemId: string,
  quantity: number,
  now: Date,
) {
  await tx.packageItem.upsert({
    where: { packageId_orderItemId: { packageId, orderItemId } },
    create: { packageId, orderItemId, quantity, packedById: actor.userId, packedAt: now },
    update: { quantity: { increment: quantity }, packedById: actor.userId, packedAt: now },
  });
}

/** Puts units of a line into a package, up to the line's unassigned units. */
export async function packUnits(
  db: Db,
  actor: Actor,
  { packageId, orderItemId, quantity = 1 }: PackUnitsInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    const line = (await unassignedByLine(tx, order.id)).find((l) => l.row.id === orderItemId);
    if (!line || !isPhysical(line.row) || !isWorkLine(line.row)) {
      throw new AppError("CONFLICT", "errors.packing.lineNotPackable");
    }
    if (quantity > line.unassigned) throw new AppError("CONFLICT", "errors.packing.nothingToPack");

    await addUnits(tx, actor, packageId, orderItemId, quantity, now);
    await invalidate(tx, packageId, true);
    return finish(tx, actor, order, "packUnits", { packageId, before: pkg }, now);
  });
}

/** Takes units of a line out of a package; the row goes at 0. */
export async function unpackUnits(
  db: Db,
  actor: Actor,
  { packageId, orderItemId, quantity = 1 }: PackUnitsInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    // Not only work lines: a line voided down to nothing may still have units to take out.
    const line = await tx.orderItem.findFirst({
      where: { id: orderItemId, orderId: order.id },
      include: lineInclude,
    });
    if (!line || !isPhysical(line))
      throw new AppError("CONFLICT", "errors.packing.lineNotPackable");
    const held = pkg.items.find((it) => it.orderItemId === orderItemId)?.quantity ?? 0;
    if (quantity > held) throw new AppError("CONFLICT", "errors.packing.notInPackage");

    const where = { packageId_orderItemId: { packageId, orderItemId } };
    if (quantity === held) await tx.packageItem.delete({ where });
    // Verification goes in the same write: the verified count can't exceed the new quantity.
    else {
      await tx.packageItem.update({
        where,
        data: {
          quantity: { decrement: quantity },
          qaVerifiedQuantity: 0,
          qaVerifiedAt: null,
          qaVerifiedById: null,
        },
      });
    }
    await invalidate(tx, packageId, true);
    return finish(tx, actor, order, "unpackUnits", { packageId, before: pkg }, now);
  });
}

/** Every physical line's unassigned units go into this package. */
export async function packRemaining(
  db: Db,
  actor: Actor,
  { packageId }: PackageIdInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    const todo = (await unassignedByLine(tx, order.id)).filter(
      (l) => isPhysical(l.row) && isWorkLine(l.row) && l.unassigned > 0,
    );
    if (todo.length === 0) throw new AppError("CONFLICT", "errors.packing.nothingToPack");

    for (const l of todo) await addUnits(tx, actor, packageId, l.row.id, l.unassigned, now);
    await invalidate(tx, packageId, true);
    return finish(tx, actor, order, "packRemaining", { packageId, before: pkg }, now);
  });
}

/**
 * Sets the package's gross weight and clears its re-weigh flag, so saving the same value confirms
 * it. Above the box's max it needs a reason and keeps it (FR-PACK-09); within it any reason is
 * dropped. Only the rates go: the contents are the same, so QA's verification stands.
 */
export async function setWeight(
  db: Db,
  actor: Actor,
  { packageId, weightOz, overrideReason }: SetWeightInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  if (weightOz > MAX_PACKAGE_WEIGHT_OZ) throw invalid("weightOz", "errors.field.tooBig");
  if (!(weightOz > 0)) throw invalid("weightOz", "errors.field.tooSmall");
  const reason = overrideReason?.trim() || null;
  if (reason && reason.length > 200) throw invalid("overrideReason", "errors.field.tooBig");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    const max = toNumber(pkg.box?.maxWeightOz ?? null);
    const over = max !== null && weightOz > max;
    if (over && !reason) {
      throw new AppError("CONFLICT", "errors.packing.overweight", undefined, {
        params: { maxOz: max },
      });
    }
    await tx.package.update({
      where: { id: packageId },
      data: { weightOz, weightOverrideReason: over ? reason : null, weightStale: false },
    });
    await dropRates(tx, packageId);
    return finish(tx, actor, order, "setWeight", { packageId, before: pkg }, now);
  });
}

/**
 * A scanned code packs one unit of the first line in pick order that matches it and still has
 * unassigned units. Refusals (unknown code, another product, everything boxed) throw before any
 * write, so they change and audit nothing. Idempotent on `scanId`: a duplicate that waited for the
 * lock packs nothing and changes nothing.
 */
export async function scanIntoPackage(
  db: Db,
  actor: Actor,
  { packageId, code, scanId }: ScanIntoPackageInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  const wanted = normalizeCode(code);
  return db.$transaction(async (tx) => {
    const ref = await tx.package.findUnique({
      where: { id: packageId },
      select: { orderId: true },
    });
    if (!ref) throw notFound();
    // A replay is answered before the checks, which may no longer pass (the order moved on).
    if (await storedResult(tx, scanId, "packing.scan", actor)) return packResult(tx, ref.orderId);

    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    let packed = false;
    await withIdempotency(tx, scanId, "packing.scan", actor, async () => {
      const lines = await unassignedByLine(tx, order.id);
      const unassigned = new Map(lines.map((l) => [l.row.id, l.unassigned]));
      const matching = matchingLines(lines.map((l) => l.row).filter(isPhysical), wanted);
      if (matching.length === 0) {
        throw await notOnOrder(tx, wanted, can(actor, "product.manage"));
      }
      const target = matching.find((row) => (unassigned.get(row.id) ?? 0) > 0);
      if (!target) {
        throw new AppError("CONFLICT", "errors.packing.scanAlreadyPacked", undefined, {
          params: { line: (matching[0] as LineRow).name },
        });
      }
      await addUnits(tx, actor, packageId, target.id, 1, now);
      packed = true;
      return { orderItemId: target.id };
    });
    // The same scan, sent twice at once: the first one packed it, this one only answers.
    if (!packed) return packResult(tx, order.id);
    await invalidate(tx, packageId, true);
    return finish(tx, actor, order, "scan", { packageId, before: pkg }, now);
  });
}
