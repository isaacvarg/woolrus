import type { ActivityTarget } from "@woolrus/contracts";
import { type ActivityRow, type DescribeContext, defineActions, field } from "./types";

// Problems: scans picking, packing and QA refused (SPEC-order-activity "Blocked scans"), read by
// `sources/scan-misses.ts`. One action per kind; none group.

const text = (row: ActivityRow, key: string) => {
  const value = field(row.after, key);
  return typeof value === "string" ? value : null;
};

/**
 * Params: `stage`, `code`, `name` (the product, when known), `batch` ("yes" for a batch scan) and
 * `box` (the box the miss names: the other box for `otherPackage`). Target: the line, else the box.
 */
function describeMiss(row: ActivityRow, ctx: DescribeContext) {
  const lineId = text(row, "orderItemId");
  const packageId = text(row, "packageId");
  const line = lineId ? ctx.lineName(lineId) : undefined;
  const box = packageId ? ctx.boxNumber(packageId) : undefined;
  const target: ActivityTarget | null = line
    ? { kind: "line", name: line }
    : box !== undefined
      ? { kind: "box", number: box }
      : null;
  return {
    params: {
      stage: text(row, "stage"),
      code: text(row, "code"),
      name: text(row, "productName") ?? line ?? null,
      batch: text(row, "batchId") ? "yes" : "no",
      box: box ?? null,
    },
    target,
  };
}

const miss = { category: "problems", groups: false, describe: describeMiss } as const;

export const scanMissActions = defineActions({
  "scanMiss.notOnOrder": miss,
  "scanMiss.unknownCode": miss,
  "scanMiss.alreadyDone": miss,
  "scanMiss.otherPackage": miss,
});
