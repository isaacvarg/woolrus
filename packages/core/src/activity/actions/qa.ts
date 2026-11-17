import {
  type ActivityRow,
  type DescribeContext,
  type Described,
  defineActions,
  field,
} from "./types";

// QA: scans, verification, box confirmation, check acknowledgements, approvals and lot
// replacement (SPEC-order-activity "Action registry", #201).

/**
 * A QA write on one box line: the line is the target (so repeats group by line), and the box is
 * a parameter. A line whose package item is gone keeps the default target, its box if known.
 */
function onLine(
  row: ActivityRow,
  ctx: DescribeContext,
  params: Described["params"] = {},
): Described {
  const item = ctx.packageItem(row.entityId);
  const name = item && ctx.lineName(item.orderItemId);
  return {
    params: { box: (item && ctx.boxNumber(item.packageId)) ?? null, ...params },
    ...(name ? { target: { kind: "line", name } } : {}),
  };
}

const after = (row: ActivityRow, key: string) => field(row.after, key);

export const qaActions = defineActions({
  /** One unit verified by scan: how many of the box line are verified now. */
  "packageItem.scan": {
    category: "qa",
    groups: true,
    describe: (row, ctx) =>
      onLine(row, ctx, {
        verified: after(row, "verifiedQuantity"),
        quantity: after(row, "quantity"),
      }),
  },
  "packageItem.verify": { category: "qa", groups: true, describe: (row, ctx) => onLine(row, ctx) },
  "packageItem.unverify": {
    category: "qa",
    groups: true,
    describe: (row, ctx) => onLine(row, ctx),
  },
  "package.confirmBox": { category: "qa", groups: false },
  /** The trip's check, and its box. Rows from before #201 have neither. */
  "packCheckTrip.acknowledge": {
    category: "qa",
    groups: false,
    describe: (row, ctx) => {
      const packageId = after(row, "packageId");
      const number = typeof packageId === "string" ? ctx.boxNumber(packageId) : undefined;
      return {
        params: { check: after(row, "check") },
        target: number === undefined ? null : { kind: "box", number },
      };
    },
  },
  "PackageCheckTrip.archive": { category: "qa", groups: false },
  "PackageCheckTrip.unarchive": { category: "qa", groups: false },
  /** Who approved, what for (the kind) and why; the entry's person is the one who asked. */
  "approval.grant": {
    category: "qa",
    groups: false,
    describe: (row, ctx) => {
      const approver = after(row, "approvedById");
      return {
        params: {
          name: (typeof approver === "string" && ctx.userName(approver)) || null,
          kind: after(row, "kind"),
          reason: after(row, "reason"),
        },
        target: null,
      };
    },
  },
  "lot.qaReplace": {
    category: "qa",
    groups: false,
    describe: (row, ctx) => onLine(row, ctx, { lot: after(row, "lotNumber") }),
  },
  "lot.qaRemove": { category: "qa", groups: false, describe: (row, ctx) => onLine(row, ctx) },
});
