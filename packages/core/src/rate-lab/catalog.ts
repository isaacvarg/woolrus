import {
  CreateLabAddressInput,
  CreateLabGroupInput,
  type DuplicateLabAddressInput,
  type LabAddress,
  LabAddressValue,
  type LabGroup,
  ListLabAddressesInput,
  ListLabGroupsInput,
  type RenameLabGroupInput,
  UpdateLabAddressInput,
} from "@woolrus/contracts";
import { type Db, type DbTx, Prisma, type RateLabGroupKind } from "@woolrus/db";
import { z } from "zod";
import type { ShipAddress, ShippingProvider } from "../adapters/shipping/provider";
import { recordAudit } from "../audit";
import { type CheckedAddress, checkAddress } from "../carriers/quote";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";

// Rate Lab's test addresses and the groups that tag them (SPEC-rate-lab "Addresses and parcels").
// Parcels are in parcels.ts.

export type CatalogDeps = {
  providers: ShippingProvider[];
  /** For tests: the address check's clock and timeout. */
  now?: Date;
  timeoutMs?: number;
};

const TITLE_MAX = 80;
const COPY_SUFFIX = " (copy)";

const addressInclude = {
  groups: { include: { group: true } },
} as const satisfies Prisma.RateLabAddressInclude;

type AddressRow = Prisma.RateLabAddressGetPayload<{ include: typeof addressInclude }>;
type GroupRow = { id: string; kind: RateLabGroupKind; name: string; archivedAt: Date | null };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** An item's groups as it shows them, by name. */
export function groupRefs(groups: { group: GroupRow }[]) {
  return groups
    .map(({ group }) => ({ id: group.id, name: group.name, archived: group.archivedAt !== null }))
    .sort(byName);
}

/** A copy's title: "… (copy)", cut to fit the 80 characters a title takes. */
export function copyTitle(title: string): string {
  return `${title.slice(0, TITLE_MAX - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

function toLabGroup(group: GroupRow): LabGroup {
  return { id: group.id, kind: group.kind, name: group.name, archived: group.archivedAt !== null };
}

function toLabAddress(row: AddressRow, lastQuotedAt: Date | null): LabAddress {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    original: LabAddressValue.parse(row.original),
    address: LabAddressValue.parse(row.address),
    residential: row.residential,
    checkStatus: row.checkStatus,
    checkMessages: z.array(z.string()).catch([]).parse(row.checkMessages),
    checkedAt: row.checkedAt,
    locked: row.lockedAt !== null,
    archived: row.archivedAt !== null,
    groups: groupRefs(row.groups),
    lastQuotedAt,
  };
}

/** When each address was last quoted, from rate history's lab fetches. */
async function lastQuoted(db: Db | DbTx, ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await db.rateFetch.groupBy({
    by: ["labAddressId"],
    where: { labAddressId: { in: ids } },
    _max: { fetchedAt: true },
  });
  return new Map(
    rows.flatMap((r) =>
      r.labAddressId && r._max.fetchedAt ? [[r.labAddressId, r._max.fetchedAt]] : [],
    ),
  );
}

async function loadAddress(tx: Db | DbTx, id: string): Promise<LabAddress> {
  const row = await tx.rateLabAddress.findUnique({ where: { id }, include: addressInclude });
  if (!row) throw notFound();
  return toLabAddress(row, (await lastQuoted(tx, [id])).get(id) ?? null);
}

/**
 * The address check (FR-SHIP-12) as a test address stores it. Residential is the provider's
 * answer, else "no company name". Never throws: no validator saves the address unchecked.
 */
export async function checkTestAddress(address: ShipAddress, deps: CatalogDeps) {
  const checked: CheckedAddress = await checkAddress(deps.providers, address, {
    now: deps.now,
    timeoutMs: deps.timeoutMs,
  });
  return {
    address: checked.shipTo as Prisma.InputJsonObject,
    residential: checked.residential ?? !address.company,
    checkStatus: checked.status,
    checkMessages: checked.messages,
    checkedAt: checked.checkedAt,
  };
}

/** The same address, whatever order its keys are in and whether blanks are absent or empty. */
function sameAddress(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) => {
    const entries = Object.entries((value ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== "")
      .sort(([x], [y]) => x.localeCompare(y));
    return JSON.stringify(entries);
  };
  return canonical(a) === canonical(b);
}

/**
 * The groups to set: each must exist and be of `kind`. An archived group stays on an item already
 * in it, but nothing new joins it.
 */
export async function resolveGroups(
  tx: DbTx,
  kind: RateLabGroupKind,
  groupIds: string[],
  keep: Set<string> = new Set(),
) {
  if (groupIds.length === 0) return;
  const groups = await tx.rateLabGroup.findMany({ where: { id: { in: groupIds } } });
  const usable = groups.filter((g) => g.kind === kind && (g.archivedAt === null || keep.has(g.id)));
  if (usable.length !== groupIds.length) {
    throw new AppError("BAD_REQUEST", "errors.rateLab.groupInvalid", {
      groupIds: "errors.rateLab.groupInvalid",
    });
  }
}

export async function listLabAddresses(
  db: Db,
  actor: Actor,
  input: z.input<typeof ListLabAddressesInput>,
): Promise<LabAddress[]> {
  assertCan(actor, "ratelab.use");
  const { groupIds, includeArchived, search } = ListLabAddressesInput.parse(input);
  const rows = await db.rateLabAddress.findMany({
    where: {
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(groupIds.length > 0 ? { groups: { some: { groupId: { in: groupIds } } } } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    },
    include: addressInclude,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const quoted = await lastQuoted(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toLabAddress(row, quoted.get(row.id) ?? null));
}

export async function createLabAddress(
  db: Db,
  actor: Actor,
  input: CreateLabAddressInput,
  deps: CatalogDeps,
): Promise<LabAddress> {
  assertCan(actor, "ratelab.manage");
  const { idempotencyKey, title, description, address, groupIds } =
    CreateLabAddressInput.parse(input);
  const checked = await checkTestAddress(address, deps);
  return db.$transaction(async (tx) => {
    // Only the id is stored for a replay, so the answer is always read fresh (with real dates).
    const { id } = await withIdempotency(
      tx,
      idempotencyKey,
      "rateLab.createAddress",
      actor,
      async () => {
        await resolveGroups(tx, "ADDRESS", groupIds);
        const row = await tx.rateLabAddress.create({
          data: {
            title,
            description,
            original: address as Prisma.InputJsonObject,
            ...checked,
            createdById: actor.userId,
            groups: { create: groupIds.map((groupId) => ({ groupId })) },
          },
        });
        await recordAudit(tx, actor, {
          entityType: "RateLabAddress",
          entityId: row.id,
          action: "create",
          after: { title, description, original: address, ...checked, groupIds } as never,
        });
        return { id: row.id };
      },
    );
    return loadAddress(tx, id);
  });
}

/**
 * Title, description and groups always change; the address only while unlocked (decision 5),
 * and a changed address is checked again.
 */
export async function updateLabAddress(
  db: Db,
  actor: Actor,
  input: UpdateLabAddressInput,
  deps: CatalogDeps,
): Promise<LabAddress> {
  assertCan(actor, "ratelab.manage");
  const { id, title, description, address, groupIds } = UpdateLabAddressInput.parse(input);
  const existing = await db.rateLabAddress.findUnique({ where: { id } });
  if (!existing) throw notFound();
  const moved = address !== undefined && !sameAddress(address, existing.original);
  if (moved && existing.lockedAt) throw new AppError("CONFLICT", "errors.rateLab.locked");
  const checked = moved ? await checkTestAddress(address, deps) : undefined;

  return db.$transaction(async (tx) => {
    // The lock is read again under a row lock: a run may have quoted it since.
    await tx.$queryRaw`SELECT id FROM rate_lab_addresses WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.rateLabAddress.findUnique({ where: { id }, include: addressInclude });
    if (!current) throw notFound();
    if (moved && current.lockedAt) throw new AppError("CONFLICT", "errors.rateLab.locked");
    const before = toLabAddress(current, null);
    if (groupIds) {
      await resolveGroups(tx, "ADDRESS", groupIds, new Set(current.groups.map((g) => g.groupId)));
    }
    await tx.rateLabAddress.update({
      where: { id },
      data: {
        title,
        description,
        ...(moved && checked ? { original: address as Prisma.InputJsonObject, ...checked } : {}),
        ...(groupIds && {
          groups: { deleteMany: {}, create: groupIds.map((groupId) => ({ groupId })) },
        }),
      },
    });
    const after = await loadAddress(tx, id);
    await recordAudit(tx, actor, {
      entityType: "RateLabAddress",
      entityId: id,
      action: "update",
      before: before as never,
      after: after as never,
    });
    return after;
  });
}

/**
 * Checks the typed original again. A locked address takes the result only when it keeps the
 * address and residential flag its runs were quoted with; otherwise the screen offers Duplicate.
 */
export async function recheckLabAddress(
  db: Db,
  actor: Actor,
  { id }: { id: string },
  deps: CatalogDeps,
): Promise<LabAddress> {
  assertCan(actor, "ratelab.manage");
  const existing = await db.rateLabAddress.findUnique({ where: { id } });
  if (!existing) throw notFound();
  const original = LabAddressValue.parse(existing.original);
  const checked = await checkTestAddress(original, deps);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rate_lab_addresses WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.rateLabAddress.findUnique({ where: { id } });
    if (!current) throw notFound();
    const changes =
      !sameAddress(checked.address, current.address) || checked.residential !== current.residential;
    if (current.lockedAt && changes) {
      throw new AppError("CONFLICT", "errors.rateLab.recheckChanged");
    }
    await tx.rateLabAddress.update({ where: { id }, data: checked });
    await recordAudit(tx, actor, {
      entityType: "RateLabAddress",
      entityId: id,
      action: "recheck",
      before: {
        address: current.address,
        residential: current.residential,
        checkStatus: current.checkStatus,
      } as Prisma.InputJsonObject,
      after: checked as never,
    });
    return loadAddress(tx, id);
  });
}

/** An unlocked copy, titled "… (copy)", in the same groups, with the same check result. */
export async function duplicateLabAddress(
  db: Db,
  actor: Actor,
  { idempotencyKey, id }: DuplicateLabAddressInput,
): Promise<LabAddress> {
  assertCan(actor, "ratelab.manage");
  return db.$transaction(async (tx) => {
    const { id: copyId } = await withIdempotency(
      tx,
      idempotencyKey,
      "rateLab.duplicateAddress",
      actor,
      async () => {
        const source = await tx.rateLabAddress.findUnique({
          where: { id },
          include: addressInclude,
        });
        if (!source) throw notFound();
        const title = copyTitle(source.title);
        const copy = await tx.rateLabAddress.create({
          data: {
            title,
            description: source.description,
            original: source.original as Prisma.InputJsonObject,
            address: source.address as Prisma.InputJsonObject,
            residential: source.residential,
            checkStatus: source.checkStatus,
            checkMessages: source.checkMessages as Prisma.InputJsonArray,
            checkedAt: source.checkedAt,
            createdById: actor.userId,
            groups: { create: source.groups.map(({ groupId }) => ({ groupId })) },
          },
        });
        await recordAudit(tx, actor, {
          entityType: "RateLabAddress",
          entityId: copy.id,
          action: "duplicate",
          after: { from: id, title },
        });
        return { id: copy.id };
      },
    );
    return loadAddress(tx, copyId);
  });
}

async function setAddressArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  assertCan(actor, "ratelab.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.rateLabAddress.findUnique({ where: { id } });
    if (!existing) throw notFound();
    if ((existing.archivedAt !== null) !== archived) {
      await tx.rateLabAddress.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
      });
      await recordAudit(tx, actor, {
        entityType: "RateLabAddress",
        entityId: id,
        action: archived ? "archive" : "unarchive",
      });
    }
    return loadAddress(tx, id);
  });
}

/** Archived addresses are never run; they stay in history and trends. */
export function archiveLabAddress(db: Db, actor: Actor, { id }: { id: string }) {
  return setAddressArchived(db, actor, id, true);
}

export function unarchiveLabAddress(db: Db, actor: Actor, { id }: { id: string }) {
  return setAddressArchived(db, actor, id, false);
}

// Groups: tags shared by addresses and parcels, by kind (decision 2).

/** The case-insensitive unique index (hand-written in the migration) refused the name. */
function groupNameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError("CONFLICT", "errors.rateLab.groupNameTaken", {
      name: "errors.rateLab.groupNameTaken",
    });
  }
  throw error;
}

export async function listLabGroups(
  db: Db,
  actor: Actor,
  input: z.input<typeof ListLabGroupsInput>,
): Promise<LabGroup[]> {
  assertCan(actor, "ratelab.use");
  const { kind, includeArchived } = ListLabGroupsInput.parse(input);
  const groups = await db.rateLabGroup.findMany({
    where: { kind, ...(includeArchived ? {} : { archivedAt: null }) },
  });
  return groups.map(toLabGroup).sort(byName);
}

export async function createLabGroup(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreateLabGroupInput>,
): Promise<LabGroup> {
  assertCan(actor, "ratelab.manage");
  const { idempotencyKey, kind, name } = CreateLabGroupInput.parse(input);
  try {
    return await db.$transaction((tx) =>
      withIdempotency(tx, idempotencyKey, "rateLab.createGroup", actor, async () => {
        const group = toLabGroup(await tx.rateLabGroup.create({ data: { kind, name } }));
        await recordAudit(tx, actor, {
          entityType: "RateLabGroup",
          entityId: group.id,
          action: "create",
          after: group,
        });
        return group;
      }),
    );
  } catch (error) {
    groupNameTaken(error);
  }
}

export async function renameLabGroup(
  db: Db,
  actor: Actor,
  { id, name }: RenameLabGroupInput,
): Promise<LabGroup> {
  assertCan(actor, "ratelab.manage");
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.rateLabGroup.findUnique({ where: { id } });
      if (!existing) throw notFound();
      const group = toLabGroup(
        await tx.rateLabGroup.update({ where: { id }, data: { name: name.trim() } }),
      );
      await recordAudit(tx, actor, {
        entityType: "RateLabGroup",
        entityId: id,
        action: "rename",
        before: { name: existing.name },
        after: { name: group.name },
      });
      return group;
    });
  } catch (error) {
    groupNameTaken(error);
  }
}

/** An archived group is hidden and never selects anything for a run; its items keep it. */
export async function archiveLabGroup(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<LabGroup> {
  assertCan(actor, "ratelab.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.rateLabGroup.findUnique({ where: { id } });
    if (!existing) throw notFound();
    if (existing.archivedAt) return toLabGroup(existing);
    const group = toLabGroup(
      await tx.rateLabGroup.update({ where: { id }, data: { archivedAt: new Date() } }),
    );
    await recordAudit(tx, actor, { entityType: "RateLabGroup", entityId: id, action: "archive" });
    return group;
  });
}
