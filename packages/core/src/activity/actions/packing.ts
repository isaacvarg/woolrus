import type { Prisma } from "@woolrus/db";
import {
  type ActionSpec,
  type ActivityRow,
  type DescribeContext,
  type Described,
  defineActions,
  field,
} from "./types";

// Packing: packages, units, weights, box scans and lots at packing (SPEC-order-activity "Action
// registry"). Package rows snapshot the box (`number`, `items` per line); lot rows are about a
// box line and snapshot its `lots`. Wording names the box and the line.

type Json = Prisma.JsonValue;
type LotEntry = { lotNumber: string | null; quantity: number };

const list = (json: Json, key: string): Json[] => {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const value = (json as Record<string, Json>)[key];
  return Array.isArray(value) ? value : [];
};

/** A package snapshot's units per line. */
function units(json: Json): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of list(json, "items")) {
    const line = field(it, "orderItemId");
    const quantity = field(it, "quantity");
    if (typeof line === "string" && typeof quantity === "number") out.set(line, quantity);
  }
  return out;
}

/** The box's number now, or as the row saw it (a removed box keeps its number). */
function boxOf(row: ActivityRow, ctx: DescribeContext, packageId: string | null): number | null {
  const current = packageId ? ctx.boxNumber(packageId) : undefined;
  const seen = field(row.after, "number") ?? field(row.before, "number");
  return current ?? (typeof seen === "number" ? seen : null);
}

const packageBox = (row: ActivityRow, ctx: DescribeContext): Described => ({
  params: { box: boxOf(row, ctx, row.entityId) },
});

/**
 * Units in or out of a box: the line whose count changed, and by how much. `packRemaining` can
 * touch several lines, so `line` is null when more than one changed; `count` is the total.
 */
function unitChange(row: ActivityRow, ctx: DescribeContext): Described {
  const before = units(row.before);
  const after = units(row.after);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .map((line) => ({ line, delta: (after.get(line) ?? 0) - (before.get(line) ?? 0) }))
    .filter((c) => c.delta !== 0);
  const only = changed.length === 1 ? changed[0] : undefined;
  return {
    params: {
      box: boxOf(row, ctx, row.entityId),
      line: (only && ctx.lineName(only.line)) ?? null,
      count: changed.reduce((sum, c) => sum + Math.abs(c.delta), 0),
    },
  };
}

const unitsSpec = (groups: boolean): ActionSpec => ({
  category: "packing",
  groups,
  describe: unitChange,
});

function lots(json: Json): LotEntry[] {
  return list(json, "lots").map((l) => {
    const lotNumber = field(l, "lotNumber");
    const quantity = field(l, "quantity");
    return {
      lotNumber: typeof lotNumber === "string" ? lotNumber : null,
      quantity: typeof quantity === "number" ? quantity : 0,
    };
  });
}

/** A lot row's box line: its box and line names. */
function boxLine(row: ActivityRow, ctx: DescribeContext) {
  const item = ctx.packageItem(row.entityId);
  return {
    box: item ? (ctx.boxNumber(item.packageId) ?? null) : null,
    line: (item && ctx.lineName(item.orderItemId)) ?? null,
  };
}

const lotSpec = (
  groups: boolean,
  lot: (row: ActivityRow) => Record<string, string | number | null>,
  extra: Partial<ActionSpec> = {},
): ActionSpec => ({
  category: "packing",
  groups,
  ...extra,
  describe: (row, ctx) => ({ params: { ...boxLine(row, ctx), ...lot(row) } }),
});

/** The lot a hand edit was about (`lotNumber` in `after`), and its quantity after the edit. */
function editedLot(row: ActivityRow) {
  const lotNumber = field(row.after, "lotNumber");
  const lot = typeof lotNumber === "string" ? lotNumber : null;
  const quantity = lot
    ? (lots(row.after).find((l) => l.lotNumber === lot)?.quantity ?? null)
    : null;
  return { lot, quantity };
}

export const packingActions = defineActions({
  "package.add": { category: "packing", groups: false, describe: packageBox },
  "package.delete": { category: "packing", groups: false, describe: packageBox },
  "package.setBox": { category: "packing", groups: false, describe: packageBox },
  "package.setWeight": {
    category: "packing",
    groups: false,
    describe: (row, ctx) => ({
      params: { box: boxOf(row, ctx, row.entityId), weightOz: field(row.after, "weightOz") },
    }),
  },
  "package.scan": unitsSpec(true),
  "package.packUnits": unitsSpec(true),
  "package.unpackUnits": unitsSpec(true),
  "package.packRemaining": unitsSpec(false),
  "lot.scan": lotSpec(true, (row) => ({ lot: field(row.after, "lotNumber") })),
  "lot.remove": lotSpec(false, (row) => ({ lot: editedLot(row).lot })),
  "lot.setQuantity": lotSpec(false, editedLot),
  "lot.validate": lotSpec(
    false,
    (row) => ({
      lot: field(row.after, "lotNumber") ?? field(row.before, "lotNumber"),
      status: field(row.after, "status"),
    }),
    { system: "lumexia" },
  ),
});
