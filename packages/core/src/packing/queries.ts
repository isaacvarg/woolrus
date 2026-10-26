import type {
  Box as BoxDto,
  PackLine,
  PackPackage,
  PackResult,
  PackView,
} from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { type BoxWithUse, toBoxDto, toBoxDtoWithUse, withUse } from "../boxes/service";
import { notFound } from "../errors";
import { lineAndPackageNoteCounts } from "../notes/targets";
import { type Actor, assertCan } from "../permissions";
import { activeQuantity, isWorkLine, type LineRow, lineInclude } from "../picking/service";
import { pickOrder } from "../picking/sort";
import { toNumber } from "../units";
import { toOrderDetails } from "../workflow/detail";
import { evaluateGate, loadGateSnapshot } from "../workflow/gates";
import { toAttributes } from "../workflow/queries";
import { estimateWeightOz, type SuggestUnit, suggestBox, weightOffPercent } from "./suggest";

// What the pack screen reads (SPEC-packing "Reads"): lines with where their units are, packages
// with their estimate and suggestion, and what the packed gate still needs.

export type PackOptions = { now?: Date };

export const packageInclude = {
  box: true,
  items: { orderBy: { packedAt: "asc" } },
} as const satisfies Prisma.PackageInclude;

export type PackageRow = Prisma.PackageGetPayload<{ include: typeof packageInclude }>;

export const isPhysical = (row: LineRow) => row.product?.physical ?? true;

/** A line's size and weight for the suggestion: the variation's, else the product's. */
function unitOf(row: LineRow, quantity: number): SuggestUnit {
  const pick = (key: "weightOz" | "lengthIn" | "widthIn" | "heightIn") =>
    toNumber(row.variation?.[key] ?? row.product?.[key] ?? null);
  return {
    name: row.name,
    lengthIn: pick("lengthIn"),
    widthIn: pick("widthIn"),
    heightIn: pick("heightIn"),
    weightOz: pick("weightOz"),
    quantity,
  };
}

function toPackPackage(
  pkg: PackageRow,
  names: Map<string, string>,
  noteCount: number,
  units: SuggestUnit[],
  boxes: BoxDto[],
): PackPackage {
  // The package's own box is in use by definition: this package uses it.
  const box = pkg.box ? toBoxDto(pkg.box, true) : null;
  const estimatedWeightOz = estimateWeightOz(units, box);
  const percent = weightOffPercent(toNumber(pkg.weightOz), estimatedWeightOz);
  const { lengthIn, widthIn, heightIn } = pkg;
  return {
    id: pkg.id,
    number: pkg.number,
    box,
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
    estimatedWeightOz,
    weightWarning: percent === null ? null : { percent },
    suggestion: suggestBox(units, boxes),
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

/** The pack screen's data for one order: lines, packages, the active boxes and the gate's unmet list. */
async function readPack(
  tx: DbTx,
  orderId: string,
  { boxCounts }: { boxCounts: boolean },
): Promise<PackResult & { boxes: BoxDto[] }> {
  const [rows, packages, notes, gate, boxRows] = await Promise.all([
    tx.orderItem.findMany({ where: { orderId }, include: lineInclude }),
    tx.package.findMany({
      where: { orderId },
      include: packageInclude,
      orderBy: { number: "asc" },
    }),
    lineAndPackageNoteCounts(tx, orderId),
    loadGateSnapshot(tx, orderId),
    // Whether a box is in use is only shown on the screen's box list, not in a write's answer.
    tx.box.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      ...(boxCounts ? { include: withUse } : {}),
    }),
  ]);
  const boxes = boxRows.map((box) =>
    "_count" in box ? toBoxDtoWithUse(box as BoxWithUse) : toBoxDto(box),
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));

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
  // Pick order walks the shelves, so it needs each line's bin; the bin isn't part of the line.
  const sorted = pickOrder(
    shown.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      binLocation: row.variation?.binLocation ?? row.product?.binLocation ?? null,
    })),
  );
  const lines: PackLine[] = sorted.map(({ id }) => {
    const row = rowById.get(id) as LineRow;
    const active = activeQuantity(row);
    const where = packedIn.get(id) ?? [];
    const packed = where.reduce((sum, w) => sum + w.quantity, 0);
    return {
      id,
      name: row.name,
      sku: row.sku,
      imageUrl: row.imageUrl,
      attributes: toAttributes(row.attributes),
      substitutionNote: row.substitutionNote,
      quantity: active,
      unassigned: Math.max(active - packed, 0),
      tooMany: Math.max(packed - active, 0),
      packedIn: where,
      noteCount: notes.items.get(id) ?? 0,
    };
  });

  const names = new Map(rows.map((row) => [row.id, row.name]));
  const unassigned = lines.flatMap((line) => {
    const row = rowById.get(line.id);
    return row && line.unassigned > 0 ? [unitOf(row, line.unassigned)] : [];
  });
  return {
    lines,
    suggestion: suggestBox(unassigned, boxes),
    packages: packages.map((pkg) =>
      toPackPackage(
        pkg,
        names,
        notes.packages.get(pkg.id) ?? 0,
        pkg.items.flatMap((it) => {
          const row = rowById.get(it.orderItemId);
          return row ? [unitOf(row, it.quantity)] : [];
        }),
        boxes,
      ),
    ),
    unmet: evaluateGate("packed", gate),
    boxes,
  };
}

/** The lines and packages as every package write returns them, one round trip for both sides. */
export async function packResult(tx: DbTx, orderId: string): Promise<PackResult> {
  const { boxes: _boxes, ...result } = await readPack(tx, orderId, { boxCounts: false });
  return result;
}

/** The pack screen for one order. */
export async function getPackView(
  db: DbTx,
  actor: Actor,
  { orderId }: { orderId: string },
  { now = new Date() }: PackOptions = {},
): Promise<PackView> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound();

  const [[detail], result] = await Promise.all([
    toOrderDetails(db, [order], { now }),
    readPack(db, orderId, { boxCounts: true }),
  ]);
  if (!detail) throw notFound();
  return { order: detail, customerNote: order.customerNote, ...result };
}
