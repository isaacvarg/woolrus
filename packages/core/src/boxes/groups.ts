import type {
  BoxGroup as BoxGroupDto,
  CreateBoxGroupInput,
  MoveBoxGroupInput,
  RenameBoxGroupInput,
} from "@woolrus/contracts";
import { type BoxGroup, type Db, type DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";

/**
 * Box groups (SPEC-packing A2 "Box groups"): named sets of boxes the pack screen's picker shows
 * together. Display only (decision 27); a box has at most one.
 */

type GroupWithCount = BoxGroup & { _count: { boxes: number } };

/** Counts the active boxes only: archived ones don't show in the picker. */
const withCount = { _count: { select: { boxes: { where: { archivedAt: null } } } } } as const;

function toDto(group: GroupWithCount): BoxGroupDto {
  return {
    id: group.id,
    name: group.name,
    position: group.position,
    boxCount: group._count.boxes,
  };
}

const order = [
  { position: "asc" },
  { name: "asc" },
] satisfies Prisma.BoxGroupOrderByWithRelationInput[];

const nameTaken = () =>
  new AppError("CONFLICT", "errors.boxGroup.nameTaken", { name: "errors.boxGroup.nameTaken" });

/** Serializes the writes that read the order (create's max, move's neighbour). */
async function lockGroups(tx: DbTx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('box_groups'))`;
}

async function checkName(tx: DbTx, name: string, id?: string) {
  const other = await tx.boxGroup.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) },
    select: { id: true },
  });
  if (other) throw nameTaken();
}

/** The `lower(name)` index the check above lost a race on. */
function uniqueTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw nameTaken();
  }
  throw error;
}

async function list(tx: DbTx | Db): Promise<BoxGroupDto[]> {
  const groups = await tx.boxGroup.findMany({ orderBy: order, include: withCount });
  return groups.map(toDto);
}

export async function listBoxGroups(db: Db, actor: Actor): Promise<BoxGroupDto[]> {
  assertCan(actor, "box.read");
  return list(db);
}

export async function createBoxGroup(
  db: Db,
  actor: Actor,
  { idempotencyKey, name: raw }: CreateBoxGroupInput,
): Promise<BoxGroupDto> {
  assertCan(actor, "box.manage");
  const name = raw.trim();
  try {
    return await db.$transaction((tx) =>
      withIdempotency(tx, idempotencyKey, "boxGroups.create", actor, async () => {
        await lockGroups(tx);
        await checkName(tx, name);
        const { _max } = await tx.boxGroup.aggregate({ _max: { position: true } });
        const group = toDto(
          await tx.boxGroup.create({
            data: { name, position: (_max.position ?? 0) + 1 },
            include: withCount,
          }),
        );
        await recordAudit(tx, actor, {
          entityType: "BoxGroup",
          entityId: group.id,
          action: "create",
          after: group,
        });
        return group;
      }),
    );
  } catch (error) {
    uniqueTaken(error);
  }
}

export async function renameBoxGroup(
  db: Db,
  actor: Actor,
  { id, name: raw }: RenameBoxGroupInput,
): Promise<BoxGroupDto> {
  assertCan(actor, "box.manage");
  const name = raw.trim();
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.boxGroup.findUnique({ where: { id }, include: withCount });
      if (!existing) throw notFound();
      await checkName(tx, name, id);
      const group = toDto(
        await tx.boxGroup.update({ where: { id }, data: { name }, include: withCount }),
      );
      await recordAudit(tx, actor, {
        entityType: "BoxGroup",
        entityId: id,
        action: "rename",
        before: { name: existing.name },
        after: { name: group.name },
      });
      return group;
    });
  } catch (error) {
    uniqueTaken(error);
  }
}

/**
 * Swaps `position` with the neighbour in the list's order. The first group moving up, or the last
 * moving down, is a no-op that returns the list unchanged and records nothing.
 */
export async function moveBoxGroup(
  db: Db,
  actor: Actor,
  { id, direction }: MoveBoxGroupInput,
): Promise<BoxGroupDto[]> {
  assertCan(actor, "box.manage");
  return db.$transaction(async (tx) => {
    await lockGroups(tx);
    const groups = await list(tx);
    const index = groups.findIndex((g) => g.id === id);
    if (index === -1) throw notFound();
    const neighbour = groups[direction === "up" ? index - 1 : index + 1];
    const group = groups[index] as BoxGroupDto;
    if (!neighbour) return groups;

    // Ties (equal positions) order by name, so a plain swap wouldn't move them: give the pair
    // distinct positions first.
    let [mine, theirs] = [neighbour.position, group.position];
    if (mine === theirs) [mine, theirs] = direction === "up" ? [mine, mine + 1] : [mine + 1, mine];
    await tx.boxGroup.update({ where: { id: group.id }, data: { position: mine } });
    await tx.boxGroup.update({ where: { id: neighbour.id }, data: { position: theirs } });
    await recordAudit(tx, actor, {
      entityType: "BoxGroup",
      entityId: id,
      action: "move",
      before: { position: group.position },
      after: { position: mine, direction, swappedWith: neighbour.name },
    });
    return list(tx);
  });
}

/** Deletes the group; its boxes, archived ones included, become ungrouped (`ON DELETE SET NULL`). */
export async function deleteBoxGroup(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<{ id: string }> {
  assertCan(actor, "box.manage");
  await db.$transaction(async (tx) => {
    // Locked so a box joining the group meanwhile waits, and is either listed below or refused.
    const [existing] = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM box_groups WHERE id = ${id}::uuid FOR UPDATE`;
    if (!existing) throw notFound();
    const boxes = await tx.box.findMany({
      where: { groupId: id },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    await tx.boxGroup.delete({ where: { id } });
    await recordAudit(tx, actor, {
      entityType: "BoxGroup",
      entityId: id,
      action: "delete",
      before: { name: existing.name, ungroupedBoxes: boxes.map((b) => b.name) },
    });
  });
  return { id };
}

/** For createBox/updateBox: an unknown group id is a bad request (`errors.boxGroup.notFound`). */
export async function checkGroupExists(tx: DbTx, groupId: string | null | undefined) {
  if (!groupId) return;
  // A key-share lock, so a delete of the group waits for this box's write and then ungroups it.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM box_groups WHERE id = ${groupId}::uuid FOR KEY SHARE`;
  if (rows.length === 0) {
    throw new AppError("BAD_REQUEST", "errors.boxGroup.notFound", {
      groupId: "errors.boxGroup.notFound",
    });
  }
}
