import type { LookupLotInput, LotLookupResult, LotShipmentRow } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import type { CsvCell } from "../csv";
import { type Actor, assertCan } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { parseLotCode } from "./codes";

// Lot lookup (SPEC-lumexia "Reads and UI", success criterion 12): every package item that holds a
// lot, from a typed lot number or a scan of the label's QR code (the lot's UUID). Packages a repack
// threw away never shipped, so they're left out; orders not shipped yet stay in, with no date.

/** A UUID matches the Lumexia lot id; anything else the lot number, ignoring case. */
function lotWhere(code: string): Prisma.PackageItemLotWhereInput {
  const parsed = parseLotCode(code);
  if (parsed?.kind === "uuid") return { lumexiaLotId: parsed.id };
  return { lotNumber: { equals: code.trim(), mode: "insensitive" } };
}

async function findLotShipments(db: DbTx, code: string): Promise<LotShipmentRow[]> {
  const lots = await db.packageItemLot.findMany({
    where: { ...lotWhere(code), packageItem: { package: { discardedAt: null } } },
    include: {
      packageItem: {
        include: {
          orderItem: { select: { name: true } },
          package: {
            select: {
              number: true,
              order: {
                select: { id: true, number: true, customerName: true, completedAt: true },
              },
            },
          },
        },
      },
    },
  });
  const rows = lots.map((lot) => {
    const { package: pkg, orderItem } = lot.packageItem;
    return {
      id: lot.id,
      orderId: pkg.order.id,
      orderNumber: pkg.order.number,
      customerName: pkg.order.customerName,
      packageNumber: pkg.number,
      productName: orderItem.name,
      lotNumber: lot.lotNumber,
      lumexiaLotId: lot.lumexiaLotId,
      quantity: lot.quantity,
      status: lot.status,
      shippedAt: pkg.order.completedAt,
    };
  });
  // Newest shipments first; orders not shipped yet lead, since they can still be stopped.
  const time = (r: LotShipmentRow) => r.shippedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return rows.sort(
    (a, b) =>
      time(b) - time(a) ||
      b.orderNumber.localeCompare(a.orderNumber, "en", { numeric: true }) ||
      a.packageNumber - b.packageNumber ||
      a.productName.localeCompare(b.productName),
  );
}

/** `order.read`: anyone who can see orders can trace a lot. */
export async function lookupLot(
  db: DbTx,
  actor: Actor,
  { code }: LookupLotInput,
): Promise<LotLookupResult> {
  assertCan(actor, "order.read");
  return { rows: await findLotShipments(db, code) };
}

/** The screen's columns, in its order. */
export const LOT_LOOKUP_CSV_HEADER = [
  "Order",
  "Customer",
  "Package",
  "Product",
  "Lot",
  "Quantity",
  "Lot status",
  "Shipped",
] as const;

export function lotShipmentCells(r: LotShipmentRow): CsvCell[] {
  return [
    r.orderNumber,
    r.customerName,
    r.packageNumber,
    r.productName,
    r.lotNumber ?? r.lumexiaLotId,
    r.quantity,
    r.status,
    r.shippedAt ? r.shippedAt.toISOString() : null,
  ];
}

/** Lot lookup's rows as CSV (FR-REP-04), the same rows as the screen. */
export async function lotLookupCsv(
  db: DbTx,
  actor: Actor,
  { code }: LookupLotInput,
): Promise<CsvExport> {
  const { rows } = await lookupLot(db, actor, { code });
  async function* cells() {
    for (const row of rows) yield lotShipmentCells(row);
  }
  // The code goes into a header: keep only what a lot number or UUID can hold.
  const safe = code
    .trim()
    .replace(/[^A-Za-z0-9.-]/g, "_")
    .slice(0, 60);
  return { filename: `lot-${safe}.csv`, header: LOT_LOOKUP_CSV_HEADER, rows: cells() };
}
