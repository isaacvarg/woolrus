import type { Prisma } from "@woolrus/db";
import { type ActivityRow, type Described, defineActions, field } from "./types";

// Shipping: rates, ship-to, labels, prints and the Woo push (SPEC-order-activity "Action registry").
// A label's own rows target it (carrier and tracking ending) through the entity; a rate's target
// its package's box.

/** Why a rate other than the cheapest was chosen: a `RateSelectionReason`, or `none`. */
const rateReason = (json: Prisma.JsonValue) => field(json, "reason") ?? "none";

/** The person's typed reason, which the timeline shows under the entry. */
const typedReason = (row: ActivityRow): Described => {
  const reason = field(row.after, "reason");
  return reason === null ? {} : { params: { reason } };
};

const list = (json: Prisma.JsonValue, key: string): Prisma.JsonValue[] => {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const value = (json as Record<string, Prisma.JsonValue>)[key];
  return Array.isArray(value) ? value : [];
};

export const shippingActions = defineActions({
  "rates.refresh": { category: "shipping", groups: true },
  "rate.select": {
    category: "shipping",
    groups: false,
    describe: (row) => ({
      params: { service: field(row.after, "serviceName"), rateReason: rateReason(row.after) },
    }),
  },
  "rate.reason": {
    category: "shipping",
    groups: false,
    describe: (row) => ({ params: { rateReason: rateReason(row.after) } }),
  },
  "shipTo.useOriginal": { category: "shipping", groups: false },
  "shipTo.recheck": { category: "shipping", groups: false },
  "labels.purchaseRequested": {
    category: "shipping",
    groups: false,
    describe: (row) => ({ params: { count: list(row.after, "packages").length } }),
  },
  "label.purchase": { category: "shipping", groups: false },
  "label.void": { category: "shipping", groups: false, describe: typedReason },
  "label.voided": { category: "shipping", groups: false },
  "label.voidRejected": { category: "shipping", groups: false },
  "label.markNotBought": { category: "shipping", groups: false, describe: typedReason },
  "label.writeOff": { category: "shipping", groups: false, describe: typedReason },
  /** One row per order per print: the order's labels in it. One label is the target. */
  "label.print": {
    category: "shipping",
    groups: true,
    describe: (row, ctx) => {
      const ids = list(row.after, "labelIds").filter((id) => typeof id === "string");
      const only = ids.length === 1 ? ctx.label(ids[0] as string) : undefined;
      return {
        params: { count: ids.length },
        target: only ? { kind: "label", ...only } : null,
      };
    },
  },
  "woo.push": { category: "shipping", groups: false, system: "shipping" },
  "woo.push.failed": { category: "shipping", groups: false, system: "shipping" },
  "woo.push.retry": { category: "shipping", groups: false },
});
