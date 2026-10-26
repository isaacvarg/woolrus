import {
  type AddPackageInput,
  MAX_PACKAGE_WEIGHT_OZ,
  type PackageBoxInput,
  type PackageIdInput,
  type PackLine,
  type PackPackage,
  type PackResult,
  type PackUnitsInput,
  type PackView,
  type SetPackageBoxInput,
  type SetWeightInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { toBoxDto } from "../boxes/service";
import { AppError, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { lineAndPackageNoteCounts } from "../notes/targets";
import { type Actor, assertCan } from "../permissions";
import { activeQuantity, isWorkLine, type LineRow, lineInclude } from "../picking/service";
import { pickOrder } from "../picking/sort";
import { toNumber } from "../units";
import { claimExpiryMinutes, holdsClaim, isClaimLive, touchClaim } from "../workflow/claims";
import { toOrderDetails } from "../workflow/detail";
import { evaluateGate, loadGateSnapshot } from "../workflow/gates";
import { type LockedOrder, lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { toAttributes } from "../workflow/queries";

// Package operations (SPEC-packing "Package rules"). Only the claim holder writes an order's
// packages, and the order row lock orders those writes against transitions. So, like pick writes,
// they don't bump Order.version: a burst of optimistic taps would otherwise make the packer's own
// completePack fail as stale.

export type PackOptions = { now?: Date };

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

const packageInclude = {
  box: true,
  items: { orderBy: { packedAt: "asc" } },
} as const satisfies Prisma.PackageInclude;

type PackageRow = Prisma.PackageGetPayload<{ include: typeof packageInclude }>;

const isPhysical = (row: LineRow) => row.product?.physical ?? true;

/** What an audit event records about a package: its box and its units per line. */
const snapshot = (pkg: PackageRow) => ({
  number: pkg.number,
  boxId: pkg.boxId,
  lengthIn: toNumber(pkg.lengthIn),
  widthIn: toNumber(pkg.widthIn),
  heightIn: toNumber(pkg.heightIn),
  items: pkg.items.map((it) => ({ orderItemId: it.orderItemId, quantity: it.quantity })),
});

function toPackPackage(
  pkg: PackageRow,
  names: Map<string, string>,
  noteCount: number,
): PackPackage {
  const { lengthIn, widthIn, heightIn } = pkg;
  return {
    id: pkg.id,
    number: pkg.number,
    box: pkg.box ? toBoxDto(pkg.box) : null,
    dimensions:
      lengthIn && widthIn && heightIn
        ? {
            lengthIn: lengthIn.toNumber(),
            widthIn: widthIn.toNumber(),
            heightIn: heightIn.toNumber(),
          }
        : null,
    weightOz: toNumber(pkg.weightOz),
    overrideReason: pkg.weightOverrideReason,
    weightStale: pkg.weightStale,
    items: pkg.items.map((it) => ({
      orderItemId: it.orderItemId,
      name: names.get(it.orderItemId) ?? "",
      quantity: it.quantity,
    })),
    units: pkg.items.reduce((sum, it) => sum + it.quantity, 0),
    noteCount,
  };
}

/** The lines and packages as the pack screen shows them, with what the packed gate still needs. */
export async function packResult(tx: DbTx, orderId: string): Promise<PackResult> {
  const [rows, packages, notes, gate] = await Promise.all([
    tx.orderItem.findMany({ where: { orderId }, include: lineInclude }),
    tx.package.findMany({
      where: { orderId },
      include: packageInclude,
      orderBy: { number: "asc" },
    }),
    lineAndPackageNoteCounts(tx, orderId),
    loadGateSnapshot(tx, orderId),
  ]);

  const packedIn = new Map<string, PackLine["packedIn"]>();
  for (const pkg of packages) {
    for (const it of pkg.items) {
      const where = packedIn.get(it.orderItemId) ?? [];
      where.push({ packageId: pkg.id, number: pkg.number, quantity: it.quantity });
      packedIn.set(it.orderItemId, where);
    }
  }

  // A fully voided line still shows while units of it sit in a box: they must be unpacked.
  const shown = rows.filter((row) => isPhysical(row) && (isWorkLine(row) || packedIn.has(row.id)));
  const lines = pickOrder(
    shown.map((row) => {
      const active = activeQuantity(row);
      const where = packedIn.get(row.id) ?? [];
      const packed = where.reduce((sum, w) => sum + w.quantity, 0);
      return {
        id: row.id,
        name: row.name,
        sku: row.sku,
        imageUrl: row.imageUrl,
        attributes: toAttributes(row.attributes),
        substitutionNote: row.substitutionNote,
        quantity: active,
        unassigned: Math.max(active - packed, 0),
        tooMany: Math.max(packed - active, 0),
        packedIn: where,
        noteCount: notes.items.get(row.id) ?? 0,
        binLocation: row.variation?.binLocation ?? row.product?.binLocation ?? null,
      };
    }),
  ).map(({ binLocation: _bin, ...line }) => line);

  const names = new Map(rows.map((row) => [row.id, row.name]));
  return {
    lines,
    packages: packages.map((pkg) => toPackPackage(pkg, names, notes.packages.get(pkg.id) ?? 0)),
    unmet: evaluateGate("packed", gate),
  };
}

/** The pack screen for one order (SPEC-packing "Reads"). */
export async function getPackView(
  db: DbTx,
  actor: Actor,
  { orderId }: { orderId: string },
  { now = new Date() }: PackOptions = {},
): Promise<PackView> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound();

  const [[detail], result, boxes] = await Promise.all([
    toOrderDetails(db, [order], { now }),
    packResult(db, orderId),
    db.box.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } }),
  ]);
  if (!detail) throw notFound();
  return {
    order: detail,
    customerNote: order.customerNote,
    ...result,
    boxes: boxes.map(toBoxDto),
  };
}

/** The columns a package's box choice sets: the box, or custom dimensions (never both). */
async function boxColumns(tx: DbTx, box: PackageBoxInput) {
  if ("boxId" in box) {
    const found = await tx.box.findUnique({ where: { id: box.boxId } });
    if (!found) throw notFound();
    if (found.archivedAt) throw new AppError("CONFLICT", "errors.packing.boxArchived");
    return { boxId: found.id, lengthIn: null, widthIn: null, heightIn: null };
  }
  return { boxId: null, lengthIn: box.lengthIn, widthIn: box.widthIn, heightIn: box.heightIn };
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
 * The package's contents or box changed: rates were fetched for the old one, and a weight read
 * before the change is kept but flagged to re-weigh or confirm (SPEC-packing decision 5). QA
 * verified the old contents, so a contents change clears it. Labels are never touched.
 */
async function invalidate(tx: DbTx, packageId: string, contentsChanged: boolean) {
  await tx.shippingRate.deleteMany({ where: { packageId } });
  await tx.package.updateMany({
    where: { id: packageId, weightOz: { not: null } },
    data: { weightStale: true },
  });
  if (contentsChanged) {
    await tx.packageItem.updateMany({
      where: { packageId },
      data: { qaVerifiedAt: null, qaVerifiedById: null },
    });
  }
}

/** The audit event, claim refresh and order_changed notify every package write ends with. */
async function finish(
  tx: DbTx,
  actor: Actor,
  order: LockedOrder,
  op: string,
  entityId: string,
  { before, after }: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue },
  now: Date,
): Promise<PackResult> {
  await recordAudit(tx, actor, {
    entityType: "Package",
    entityId,
    action: `package.${op}`,
    before,
    after,
    at: now,
  });
  await touchClaim(tx, actor, order.id, { now });
  await notifyOrderChanged(tx, { id: order.id, status: order.status });
  return packResult(tx, order.id);
}

const invalid = (field: string, key: "errors.field.tooBig" | "errors.field.tooSmall") =>
  new AppError("BAD_REQUEST", "errors.validation", { [field]: key });

const reload = (tx: DbTx, packageId: string) =>
  tx.package.findUniqueOrThrow({ where: { id: packageId }, include: packageInclude });

/** Adds a package after the last one. Idempotent on the key. */
export async function addPackage(
  db: Db,
  actor: Actor,
  { orderId, box, idempotencyKey }: AddPackageInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    // A replay is answered before the checks, which may no longer pass (the order moved on).
    if (await storedResult(tx, idempotencyKey, "packing.addPackage", actor)) {
      return packResult(tx, orderId);
    }
    const order = await lockForPacking(tx, actor, orderId, now);
    const columns = await boxColumns(tx, box);
    const created = await withIdempotency(
      tx,
      idempotencyKey,
      "packing.addPackage",
      actor,
      async () => {
        const last = await tx.package.aggregate({ where: { orderId }, _max: { number: true } });
        const pkg = await tx.package.create({
          data: { orderId, number: (last._max.number ?? 0) + 1, ...columns },
          include: packageInclude,
        });
        return { id: pkg.id };
      },
    );
    const pkg = await reload(tx, created.id);
    return finish(tx, actor, order, "add", pkg.id, { after: snapshot(pkg) }, now);
  });
}

/** Replaces a package's box or custom dimensions. */
export async function setPackageBox(
  db: Db,
  actor: Actor,
  { packageId, box }: SetPackageBoxInput,
  { now = new Date() }: PackOptions = {},
): Promise<PackResult> {
  assertCan(actor, "order.pack");
  return db.$transaction(async (tx) => {
    const { order, pkg } = await lockPackage(tx, actor, packageId, now);
    const columns = await boxColumns(tx, box);
    await tx.package.update({ where: { id: packageId }, data: columns });
    await invalidate(tx, packageId, false);
    const after = await reload(tx, packageId);
    return finish(
      tx,
      actor,
      order,
      "setBox",
      packageId,
      { before: snapshot(pkg), after: snapshot(after) },
      now,
    );
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
    return finish(tx, actor, order, "delete", packageId, { before: snapshot(pkg) }, now);
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
    const after = await reload(tx, packageId);
    return finish(
      tx,
      actor,
      order,
      "packUnits",
      packageId,
      { before: snapshot(pkg), after: snapshot(after) },
      now,
    );
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
    if (quantity > held) throw new AppError("CONFLICT", "errors.packing.nothingToPack");

    if (quantity === held) {
      await tx.packageItem.delete({ where: { packageId_orderItemId: { packageId, orderItemId } } });
    } else {
      await tx.packageItem.update({
        where: { packageId_orderItemId: { packageId, orderItemId } },
        data: { quantity: { decrement: quantity } },
      });
    }
    await invalidate(tx, packageId, true);
    const after = await reload(tx, packageId);
    return finish(
      tx,
      actor,
      order,
      "unpackUnits",
      packageId,
      { before: snapshot(pkg), after: snapshot(after) },
      now,
    );
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
    const after = await reload(tx, packageId);
    return finish(
      tx,
      actor,
      order,
      "packRemaining",
      packageId,
      { before: snapshot(pkg), after: snapshot(after) },
      now,
    );
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
    await tx.shippingRate.deleteMany({ where: { packageId } });
    const after = await reload(tx, packageId);
    const record = (p: PackageRow) => ({
      ...snapshot(p),
      weightOz: toNumber(p.weightOz),
      overrideReason: p.weightOverrideReason,
      weightStale: p.weightStale,
    });
    return finish(
      tx,
      actor,
      order,
      "setWeight",
      packageId,
      { before: record(pkg), after: record(after) },
      now,
    );
  });
}
