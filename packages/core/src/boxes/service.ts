import type { Box as BoxDto, CreateBoxInput } from "@woolrus/contracts";
import { type Box, type Db, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { toNumber } from "../units";

export function toBoxDto(box: Box): BoxDto {
  return {
    id: box.id,
    name: box.name,
    lengthIn: toNumber(box.lengthIn),
    widthIn: toNumber(box.widthIn),
    heightIn: toNumber(box.heightIn),
    maxWeightOz: toNumber(box.maxWeightOz),
    tareWeightOz: toNumber(box.tareWeightOz),
    archived: box.archivedAt !== null,
  };
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
  });
  return boxes.map(toBoxDto);
}

export async function createBox(db: Db, actor: Actor, input: CreateBoxInput): Promise<BoxDto> {
  assertCan(actor, "box.manage");
  const { idempotencyKey, ...data } = input;
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("CONFLICT", "errors.box.nameTaken", { name: "errors.box.nameTaken" });
    }
    throw error;
  }
}

export async function archiveBox(db: Db, actor: Actor, { id }: { id: string }): Promise<BoxDto> {
  assertCan(actor, "box.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.box.findUnique({ where: { id } });
    if (!existing) throw notFound();
    if (existing.archivedAt) return toBoxDto(existing);
    const box = toBoxDto(await tx.box.update({ where: { id }, data: { archivedAt: new Date() } }));
    await recordAudit(tx, actor, { entityType: "Box", entityId: id, action: "archive" });
    return box;
  });
}
