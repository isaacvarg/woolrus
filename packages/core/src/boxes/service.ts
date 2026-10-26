import type { Box as BoxDto, CreateBoxInput, UpdateBoxInput } from "@woolrus/contracts";
import { type Box, type Db, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { toNumber } from "../units";

/** `inUse` is only known by callers that counted packages; the pack view doesn't need it. */
export function toBoxDto(box: Box, inUse = false): BoxDto {
  return {
    id: box.id,
    name: box.name,
    lengthIn: toNumber(box.lengthIn),
    widthIn: toNumber(box.widthIn),
    heightIn: toNumber(box.heightIn),
    maxWeightOz: toNumber(box.maxWeightOz),
    tareWeightOz: toNumber(box.tareWeightOz),
    outerLengthIn: toNumber(box.outerLengthIn),
    outerWidthIn: toNumber(box.outerWidthIn),
    outerHeightIn: toNumber(box.outerHeightIn),
    inUse,
    archived: box.archivedAt !== null,
  };
}

type Triple = [number, number, number];
export type BoxWithUse = Box & { _count: { packages: number } };

/** Include for the count that says whether any package uses the box. */
export const withUse = { _count: { select: { packages: true } } } as const;

export function toBoxDtoWithUse(box: BoxWithUse): BoxDto {
  return toBoxDto(box, box._count.packages > 0);
}

/** All three outer dimensions or none, none smaller than the matching inner one. */
function checkOuter(inner: Triple, outer: (number | null | undefined)[]) {
  const set = outer.filter((v) => v != null);
  if (set.length === 0) return;
  if (set.length !== 3) {
    throw new AppError("BAD_REQUEST", "errors.validation", {
      outerLengthIn: "errors.field.required",
    });
  }
  if (outer.some((v, i) => (v as number) < (inner[i] as number))) {
    throw new AppError("BAD_REQUEST", "errors.box.outerSmaller", {
      outerLengthIn: "errors.box.outerSmaller",
    });
  }
}

function nameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError("CONFLICT", "errors.box.nameTaken", { name: "errors.box.nameTaken" });
  }
  throw error;
}

export async function listBoxes(
  db: Db,
  actor: Actor,
  { includeArchived }: { includeArchived: boolean },
): Promise<BoxDto[]> {
  assertCan(actor, "box.read");
  const boxes = await db.box.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { name: "asc" },
    include: withUse,
  });
  return boxes.map(toBoxDtoWithUse);
}

export async function createBox(db: Db, actor: Actor, input: CreateBoxInput): Promise<BoxDto> {
  assertCan(actor, "box.manage");
  const { idempotencyKey, ...data } = input;
  checkOuter(
    [data.lengthIn, data.widthIn, data.heightIn],
    [data.outerLengthIn, data.outerWidthIn, data.outerHeightIn],
  );
  try {
    return await db.$transaction((tx) =>
      withIdempotency(tx, idempotencyKey, "boxes.create", actor, async () => {
        const box = toBoxDto(await tx.box.create({ data }));
        await recordAudit(tx, actor, {
          entityType: "Box",
          entityId: box.id,
          action: "create",
          after: box,
        });
        return box;
      }),
    );
  } catch (error) {
    nameTaken(error);
  }
}

export async function archiveBox(db: Db, actor: Actor, { id }: { id: string }): Promise<BoxDto> {
  assertCan(actor, "box.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.box.findUnique({ where: { id }, include: withUse });
    if (!existing) throw notFound();
    if (existing.archivedAt) return toBoxDtoWithUse(existing);
    const box = toBoxDtoWithUse(
      await tx.box.update({ where: { id }, data: { archivedAt: new Date() }, include: withUse }),
    );
    await recordAudit(tx, actor, { entityType: "Box", entityId: id, action: "archive" });
    return box;
  });
}

export async function restoreBox(db: Db, actor: Actor, { id }: { id: string }): Promise<BoxDto> {
  assertCan(actor, "box.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.box.findUnique({ where: { id }, include: withUse });
    if (!existing) throw notFound();
    if (!existing.archivedAt) return toBoxDtoWithUse(existing);
    const box = toBoxDtoWithUse(
      await tx.box.update({ where: { id }, data: { archivedAt: null }, include: withUse }),
    );
    await recordAudit(tx, actor, { entityType: "Box", entityId: id, action: "restore" });
    return box;
  });
}

/** Inner/outer dimensions change only while no package uses the box (a resized box is a new box). */
export async function updateBox(db: Db, actor: Actor, input: UpdateBoxInput): Promise<BoxDto> {
  assertCan(actor, "box.manage");
  const { id, ...changes } = input;
  try {
    return await db.$transaction(async (tx) => {
      // Held to commit: a package being added or re-boxed holds a key-share lock on the box
      // through its foreign key, so this waits for it and the in-use count below sees it.
      await tx.$queryRaw`SELECT id FROM boxes WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.box.findUnique({ where: { id }, include: withUse });
      if (!existing) throw notFound();
      const before = toBoxDtoWithUse(existing);

      const next = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      const dimensionKeys = [
        "lengthIn",
        "widthIn",
        "heightIn",
        "outerLengthIn",
        "outerWidthIn",
        "outerHeightIn",
      ] as const;
      if (before.inUse && dimensionKeys.some((k) => next[k] !== before[k])) {
        throw new AppError("CONFLICT", "errors.box.dimensionsLocked");
      }
      checkOuter(
        [next.lengthIn, next.widthIn, next.heightIn],
        [next.outerLengthIn, next.outerWidthIn, next.outerHeightIn],
      );

      const box = toBoxDtoWithUse(
        await tx.box.update({ where: { id }, data: changes, include: withUse }),
      );
      await recordAudit(tx, actor, {
        entityType: "Box",
        entityId: id,
        action: "update",
        before,
        after: box,
      });
      return box;
    });
  } catch (error) {
    nameTaken(error);
  }
}

export async function deleteBox(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<{ id: string }> {
  assertCan(actor, "box.manage");
  try {
    await db.$transaction(async (tx) => {
      // As in updateBox: wait for a package being added, so the in-use count below sees it.
      await tx.$queryRaw`SELECT id FROM boxes WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.box.findUnique({ where: { id }, include: withUse });
      if (!existing) throw notFound();
      if (existing._count.packages > 0) throw new AppError("CONFLICT", "errors.box.inUse");
      await tx.box.delete({ where: { id } });
      await recordAudit(tx, actor, {
        entityType: "Box",
        entityId: id,
        action: "delete",
        before: toBoxDtoWithUse(existing),
      });
    });
  } catch (error) {
    // A package that got in anyway: the foreign key refuses the delete, as the count would have.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new AppError("CONFLICT", "errors.box.inUse");
    }
    throw error;
  }
  return { id };
}
