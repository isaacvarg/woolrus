import type { NoteTarget, NoteTargetInput } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { AppError } from "../errors";

// A note is always on an order, plus at most one narrower target (the `notes_single_target`
// constraint). `returnId` is reserved for `returns`.

const LABEL_MAX = 80;

/** What `targetOf` needs to name a note's target. */
export const targetInclude = {
  order: { select: { number: true } },
  orderItem: { select: { name: true, quantity: true } },
  package: { select: { number: true } },
  qualityIssue: { select: { description: true } },
} satisfies Prisma.NoteInclude;

type TargetedNote = Prisma.NoteGetPayload<{ include: typeof targetInclude }>;

const cut = (text: string) =>
  text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1).trimEnd()}…` : text;

export function targetOf(note: TargetedNote): NoteTarget {
  if (note.orderItemId && note.orderItem) {
    const { name, quantity } = note.orderItem;
    return { kind: "item", id: note.orderItemId, label: `${name} ×${quantity}` };
  }
  if (note.packageId && note.package) {
    return { kind: "package", id: note.packageId, label: String(note.package.number) };
  }
  if (note.qualityIssueId && note.qualityIssue) {
    return { kind: "issue", id: note.qualityIssueId, label: cut(note.qualityIssue.description) };
  }
  return { kind: "order", id: note.orderId, label: note.order.number };
}

type TargetColumns = { orderItemId?: string; packageId?: string; qualityIssueId?: string };

/**
 * The note's target columns, once the target is known to belong to the order. An unknown id is
 * refused the same way: from the caller's side both are "not on this order".
 */
export async function resolveTarget(
  tx: DbTx,
  orderId: string,
  target: NoteTargetInput,
): Promise<TargetColumns> {
  const where = (id: string) => ({ where: { id, orderId }, select: { id: true } });
  let found: { id: string } | null;
  let columns: TargetColumns;
  switch (target.kind) {
    case "order":
      return {};
    case "item":
      found = await tx.orderItem.findFirst(where(target.id));
      columns = { orderItemId: target.id };
      break;
    case "package":
      found = await tx.package.findFirst(where(target.id));
      columns = { packageId: target.id };
      break;
    case "issue":
      found = await tx.qualityIssue.findFirst(where(target.id));
      columns = { qualityIssueId: target.id };
      break;
  }
  if (!found) throw new AppError("BAD_REQUEST", "errors.notes.targetMismatch");
  return columns;
}

/** Notes per order, all targets: one grouped query (FR-NOTE-05). Orders without notes are absent. */
export async function noteCounts(
  tx: DbTx,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const groups = await tx.note.groupBy({
    by: ["orderId"],
    where: { orderId: { in: [...orderIds] } },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.orderId, g._count._all]));
}

/** Notes on each line and package of one order, in one grouped query. */
/** Line notes per line across several orders, in one grouped query. Lines without notes are absent. */
export async function lineNoteCounts(
  tx: DbTx,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const groups = await tx.note.groupBy({
    by: ["orderItemId"],
    where: { orderId: { in: [...orderIds] }, orderItemId: { not: null } },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.orderItemId as string, g._count._all]));
}

export async function lineAndPackageNoteCounts(
  tx: DbTx,
  orderId: string,
): Promise<{ items: Map<string, number>; packages: Map<string, number> }> {
  const groups = await tx.note.groupBy({
    by: ["orderItemId", "packageId"],
    where: { orderId, OR: [{ orderItemId: { not: null } }, { packageId: { not: null } }] },
    _count: { _all: true },
  });
  const items = new Map<string, number>();
  const packages = new Map<string, number>();
  for (const g of groups) {
    if (g.orderItemId) items.set(g.orderItemId, g._count._all);
    if (g.packageId) packages.set(g.packageId, g._count._all);
  }
  return { items, packages };
}
