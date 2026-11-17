import type { ActivityTarget } from "@woolrus/contracts";
import { type ActivityRow, type DescribeContext, defineActions, field } from "./types";

// Problems: voids and quality issues; none of them group. Scan misses are Problems too, but come
// from their own source and file (#205). Codes (issue type, severity, outcome, void resolution)
// go out as they are; the wording selects on them.

const fromRow = (row: ActivityRow, key: string) => field(row.after, key) ?? field(row.before, key);

/** The line or box the row names (`orderItemId`, `packageId`), else none: the order itself. */
export function problemTarget(row: ActivityRow, ctx: DescribeContext): ActivityTarget | null {
  const line = fromRow(row, "orderItemId");
  const name = typeof line === "string" ? ctx.lineName(line) : undefined;
  if (name) return { kind: "line", name };
  const box = fromRow(row, "packageId");
  const number = typeof box === "string" ? ctx.boxNumber(box) : undefined;
  return number === undefined ? null : { kind: "box", number };
}

const onTarget = (row: ActivityRow, ctx: DescribeContext) => ({ target: problemTarget(row, ctx) });

export const problemActions = defineActions({
  "void.create": {
    category: "problems",
    groups: false,
    describe: (row, ctx) => ({
      params: { quantity: field(row.after, "quantity") },
      target: problemTarget(row, ctx),
    }),
  },
  "void.undo": { category: "problems", groups: false, describe: onTarget },
  "void.resolve": {
    category: "problems",
    groups: false,
    describe: (row, ctx) => ({
      params: { resolution: field(row.after, "resolution") },
      target: problemTarget(row, ctx),
    }),
  },
  "issue.report": {
    category: "problems",
    groups: false,
    describe: (row, ctx) => ({
      params: { type: field(row.after, "type"), severity: field(row.after, "severity") },
      target: problemTarget(row, ctx),
    }),
  },
  "issue.update": { category: "problems", groups: false, describe: onTarget },
  "issue.setResponsible": {
    category: "problems",
    groups: false,
    describe: (row, ctx) => {
      const id = field(row.after, "responsibleUserId");
      return { params: { name: (typeof id === "string" && ctx.userName(id)) || null } };
    },
  },
  "issue.resolve": {
    category: "problems",
    groups: false,
    describe: (row) => ({ params: { outcome: field(row.after, "status") } }),
  },
  "issue.reopen": { category: "problems", groups: false },
  "issue.delete": { category: "problems", groups: false, describe: onTarget },
  "issue.linkRepack": { category: "problems", groups: false },
});
