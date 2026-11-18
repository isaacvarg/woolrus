import type { ActivityRow, DescribeContext, Described } from "./types";
import { defineActions, field } from "./types";

// Picking: picks, batches and barcode links (SPEC-order-activity "Action registry", #199).

/** A line's name: the order's line by id, else none (the row's own target still shows). */
const lineName = (ctx: DescribeContext, id: string | number | null) =>
  (id !== null && ctx.lineName(String(id))) || null;

/** A pick row: the line, and how many are picked after it (before it, for an unpick). */
const pick =
  (side: "before" | "after") =>
  (row: ActivityRow, ctx: DescribeContext): Described => ({
    params: {
      line: lineName(ctx, row.entityId),
      quantity: field(row[side], "pickedQuantity"),
    },
  });

/** A batch row: its number, and for joining, how many orders it started with. */
const batch = (row: ActivityRow): Described => {
  const after = row.after;
  const orders =
    after && typeof after === "object" && !Array.isArray(after) && Array.isArray(after.orders)
      ? after.orders.length
      : null;
  return {
    params: {
      number: field(after, "number"),
      ...(row.action === "pickBatch.create" ? { orders } : {}),
    },
  };
};

export const pickingActions = defineActions({
  "pick.scan": { category: "picking", groups: true, describe: pick("after") },
  "pick.pickLine": { category: "picking", groups: true, describe: pick("after") },
  "pick.unpickLine": { category: "picking", groups: true, describe: pick("before") },
  "pick.markOutOfStock": { category: "picking", groups: false, describe: pick("after") },
  "pick.substitute": { category: "picking", groups: false, describe: pick("after") },
  "pickBatch.create": { category: "picking", groups: false, describe: batch },
  "pickBatch.removeOrder": { category: "picking", groups: false, describe: batch },
  "pickBatch.close": { category: "picking", groups: false, describe: batch },
  "pickBatch.finish": { category: "picking", groups: false, describe: batch },
  "product.linkBarcode": {
    category: "picking",
    groups: false,
    describe: (row, ctx) => {
      const line = lineName(ctx, field(row.after, "orderItemId"));
      return {
        params: { line, barcode: field(row.after, "barcode") },
        target: line ? { kind: "line", name: line } : null,
      };
    },
  },
});
