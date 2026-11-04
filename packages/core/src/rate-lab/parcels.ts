import {
  CreateLabParcelInput,
  type DuplicateLabParcelInput,
  type LabParcel,
  type LabParcelProduct,
  ListLabParcelProductsInput,
  ListLabParcelsInput,
  UpdateLabParcelInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma } from "@woolrus/db";
import type { z } from "zod";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { toNumber } from "../units";
import { copyTitle, groupRefs, resolveGroups } from "./catalog";

// Rate Lab's test parcels (SPEC-rate-lab "Addresses and parcels"): a size copied from a box or
// typed, a weight, and optional contents for customs (decision 4). Locked once quoted (decision 5).

const PRODUCT_PICKS = 20;

const parcelInclude = {
  box: { select: { id: true, name: true } },
  groups: { include: { group: true } },
  items: {
    include: { product: { select: { id: true, name: true, sku: true } } },
    orderBy: { product: { name: "asc" } },
  },
} as const satisfies Prisma.RateLabParcelInclude;

type ParcelRow = Prisma.RateLabParcelGetPayload<{ include: typeof parcelInclude }>;

/** What a run quotes: once locked, none of it may change. */
type Physical = {
  boxId: string | null;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
  items: { productId: string; quantity: number }[];
};

function toLabParcel(row: ParcelRow, lastQuotedAt: Date | null): LabParcel {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    box: row.box,
    lengthIn: toNumber(row.lengthIn),
    widthIn: toNumber(row.widthIn),
    heightIn: toNumber(row.heightIn),
    weightOz: toNumber(row.weightOz),
    items: row.items.map(({ product, quantity }) => ({ product, quantity })),
    locked: row.lockedAt !== null,
    archived: row.archivedAt !== null,
    groups: groupRefs(row.groups),
    lastQuotedAt,
  };
}

function physicalOf(row: ParcelRow): Physical {
  const parcel = toLabParcel(row, null);
  return {
    boxId: row.boxId,
    lengthIn: parcel.lengthIn,
    widthIn: parcel.widthIn,
    heightIn: parcel.heightIn,
    weightOz: parcel.weightOz,
    items: parcel.items.map(({ product, quantity }) => ({ productId: product.id, quantity })),
  };
}

function samePhysical(a: Physical, b: Physical): boolean {
  const canonical = ({ items, ...rest }: Physical) =>
    JSON.stringify({
      ...rest,
      items: [...items].sort((x, y) => x.productId.localeCompare(y.productId)),
    });
  return canonical(a) === canonical(b);
}

/** When each parcel was last quoted, from rate history's lab fetches. */
async function lastQuoted(db: Db | DbTx, ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await db.rateFetch.groupBy({
    by: ["labParcelId"],
    where: { labParcelId: { in: ids } },
    _max: { fetchedAt: true },
  });
  return new Map(
    rows.flatMap((r) =>
      r.labParcelId && r._max.fetchedAt ? [[r.labParcelId, r._max.fetchedAt]] : [],
    ),
  );
}

async function loadParcel(tx: Db | DbTx, id: string): Promise<LabParcel> {
  const row = await tx.rateLabParcel.findUnique({ where: { id }, include: parcelInclude });
  if (!row) throw notFound();
  return toLabParcel(row, (await lastQuoted(tx, [id])).get(id) ?? null);
}

type SizeInput = z.output<typeof CreateLabParcelInput>["size"];

/**
 * The size to store. A box copies its inner size, and must be active unless it's the box the
 * parcel already has: that one keeps the size it copied, whatever the box says now.
 */
export async function resolveParcelSize(
  tx: DbTx,
  size: SizeInput,
  current?: Physical,
): Promise<Pick<Physical, "boxId" | "lengthIn" | "widthIn" | "heightIn">> {
  if (size.boxId === null) {
    return {
      boxId: null,
      lengthIn: size.lengthIn as number,
      widthIn: size.widthIn as number,
      heightIn: size.heightIn as number,
    };
  }
  if (current && current.boxId === size.boxId) {
    const { boxId, lengthIn, widthIn, heightIn } = current;
    return { boxId, lengthIn, widthIn, heightIn };
  }
  const box = await tx.box.findUnique({ where: { id: size.boxId } });
  if (!box || box.archivedAt) {
    throw new AppError("BAD_REQUEST", "errors.rateLab.boxInvalid", {
      "size.boxId": "errors.rateLab.boxInvalid",
    });
  }
  return {
    boxId: box.id,
    lengthIn: toNumber(box.lengthIn),
    widthIn: toNumber(box.widthIn),
    heightIn: toNumber(box.heightIn),
  };
}

/** Contents are catalog products handled on the floor: no virtual products (decision 4). */
async function checkItems(tx: DbTx, items: Physical["items"]) {
  if (items.length === 0) return;
  const ids = items.map((i) => i.productId);
  const physical = await tx.product.count({ where: { id: { in: ids }, physical: true } });
  if (physical !== ids.length) {
    throw new AppError("BAD_REQUEST", "errors.rateLab.itemNotPhysical", {
      items: "errors.rateLab.itemNotPhysical",
    });
  }
}

const physicalData = ({ items: _items, ...size }: Physical) => size;

export async function listLabParcels(
  db: Db,
  actor: Actor,
  input: z.input<typeof ListLabParcelsInput>,
): Promise<LabParcel[]> {
  assertCan(actor, "ratelab.use");
  const { groupIds, includeArchived, search } = ListLabParcelsInput.parse(input);
  const rows = await db.rateLabParcel.findMany({
    where: {
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(groupIds.length > 0 ? { groups: { some: { groupId: { in: groupIds } } } } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    },
    include: parcelInclude,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const quoted = await lastQuoted(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toLabParcel(row, quoted.get(row.id) ?? null));
}

/** Physical products matching the name or SKU, for the contents picker. */
export async function listLabParcelProducts(
  db: Db,
  actor: Actor,
  input: z.input<typeof ListLabParcelProductsInput>,
): Promise<LabParcelProduct[]> {
  assertCan(actor, "ratelab.use");
  const { search } = ListLabParcelProductsInput.parse(input);
  return db.product.findMany({
    where: {
      physical: true,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { sku: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: { id: true, name: true, sku: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: PRODUCT_PICKS,
  });
}

export async function createLabParcel(
  db: Db,
  actor: Actor,
  input: CreateLabParcelInput,
): Promise<LabParcel> {
  assertCan(actor, "ratelab.manage");
  const { idempotencyKey, title, description, size, weightOz, items, groupIds } =
    CreateLabParcelInput.parse(input);
  return db.$transaction(async (tx) => {
    // Only the id is stored for a replay, so the answer is always read fresh (with real dates).
    const { id } = await withIdempotency(
      tx,
      idempotencyKey,
      "rateLab.createParcel",
      actor,
      async () => {
        await resolveGroups(tx, "PARCEL", groupIds);
        await checkItems(tx, items);
        const physical: Physical = { ...(await resolveParcelSize(tx, size)), weightOz, items };
        const row = await tx.rateLabParcel.create({
          data: {
            title,
            description,
            ...physicalData(physical),
            createdById: actor.userId,
            groups: { create: groupIds.map((groupId) => ({ groupId })) },
            items: { create: items },
          },
        });
        await recordAudit(tx, actor, {
          entityType: "RateLabParcel",
          entityId: row.id,
          action: "create",
          after: { title, description, ...physical, groupIds },
        });
        return { id: row.id };
      },
    );
    return loadParcel(tx, id);
  });
}

/**
 * Title, description and groups always change; size, weight and contents only while unlocked
 * (decision 5). Sending them unchanged to a locked parcel is fine.
 */
export async function updateLabParcel(
  db: Db,
  actor: Actor,
  input: UpdateLabParcelInput,
): Promise<LabParcel> {
  assertCan(actor, "ratelab.manage");
  const { id, title, description, size, weightOz, items, groupIds } =
    UpdateLabParcelInput.parse(input);

  return db.$transaction(async (tx) => {
    // The lock is read under a row lock: a run may quote it meanwhile.
    await tx.$queryRaw`SELECT id FROM rate_lab_parcels WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.rateLabParcel.findUnique({ where: { id }, include: parcelInclude });
    if (!current) throw notFound();
    const before = physicalOf(current);
    const after: Physical = {
      ...before,
      ...(size ? await resolveParcelSize(tx, size, before) : {}),
      ...(weightOz !== undefined ? { weightOz } : {}),
      ...(items ? { items } : {}),
    };
    const moved = !samePhysical(before, after);
    if (moved && current.lockedAt) throw new AppError("CONFLICT", "errors.rateLab.parcelLocked");
    if (items) await checkItems(tx, items);
    if (groupIds) {
      await resolveGroups(tx, "PARCEL", groupIds, new Set(current.groups.map((g) => g.groupId)));
    }
    await tx.rateLabParcel.update({
      where: { id },
      data: {
        title,
        description,
        ...(moved && {
          ...physicalData(after),
          items: { deleteMany: {}, create: after.items },
        }),
        ...(groupIds && {
          groups: { deleteMany: {}, create: groupIds.map((groupId) => ({ groupId })) },
        }),
      },
    });
    const updated = await loadParcel(tx, id);
    await recordAudit(tx, actor, {
      entityType: "RateLabParcel",
      entityId: id,
      action: "update",
      before: toLabParcel(current, null) as never,
      after: updated as never,
    });
    return updated;
  });
}

/** An unlocked copy, titled "… (copy)", with the same box link, size, contents and groups. */
export async function duplicateLabParcel(
  db: Db,
  actor: Actor,
  { idempotencyKey, id }: DuplicateLabParcelInput,
): Promise<LabParcel> {
  assertCan(actor, "ratelab.manage");
  return db.$transaction(async (tx) => {
    const { id: copyId } = await withIdempotency(
      tx,
      idempotencyKey,
      "rateLab.duplicateParcel",
      actor,
      async () => {
        const source = await tx.rateLabParcel.findUnique({
          where: { id },
          include: parcelInclude,
        });
        if (!source) throw notFound();
        const title = copyTitle(source.title);
        const physical = physicalOf(source);
        const copy = await tx.rateLabParcel.create({
          data: {
            title,
            description: source.description,
            ...physicalData(physical),
            createdById: actor.userId,
            groups: { create: source.groups.map(({ groupId }) => ({ groupId })) },
            items: { create: physical.items },
          },
        });
        await recordAudit(tx, actor, {
          entityType: "RateLabParcel",
          entityId: copy.id,
          action: "duplicate",
          after: { from: id, title },
        });
        return { id: copy.id };
      },
    );
    return loadParcel(tx, copyId);
  });
}

async function setParcelArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  assertCan(actor, "ratelab.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.rateLabParcel.findUnique({ where: { id } });
    if (!existing) throw notFound();
    if ((existing.archivedAt !== null) !== archived) {
      await tx.rateLabParcel.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
      });
      await recordAudit(tx, actor, {
        entityType: "RateLabParcel",
        entityId: id,
        action: archived ? "archive" : "unarchive",
      });
    }
    return loadParcel(tx, id);
  });
}

/** Archived parcels are never run; they stay in history and trends. */
export function archiveLabParcel(db: Db, actor: Actor, { id }: { id: string }) {
  return setParcelArchived(db, actor, id, true);
}

export function unarchiveLabParcel(db: Db, actor: Actor, { id }: { id: string }) {
  return setParcelArchived(db, actor, id, false);
}
