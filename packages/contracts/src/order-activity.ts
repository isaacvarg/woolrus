import { z } from "zod";
import { base, Id } from "./base";

// The order's activity feed (SPEC-order-activity "Timeline", "API"). The server sends action keys
// and parameters; the web app words them (`activity.action.*`), so an action with no wording yet
// still renders, as a generic "Changed <entity>" line.

/** The timeline's filters. Every entry belongs to exactly one. */
export const ActivityCategory = z.enum([
  "status",
  "picking",
  "packing",
  "qa",
  "shipping",
  "problems",
  "notes",
  "store",
]);
export type ActivityCategory = z.infer<typeof ActivityCategory>;

/** What an entry is about, beyond the order itself. Grouping compares it. */
export const ActivityTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), name: z.string() }),
  z.object({ kind: z.literal("box"), number: z.number().int() }),
  z.object({
    kind: z.literal("label"),
    carrier: z.string(),
    /** The last characters of the tracking number, when there is one. */
    trackingEnd: z.string().nullable(),
  }),
]);
export type ActivityTarget = z.infer<typeof ActivityTarget>;

/** Values for the action's message. Status params (`from`, `to`) are workflow statuses. */
export const ActivityParams = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type ActivityParams = z.infer<typeof ActivityParams>;

export const ActivityItem = z.object({
  id: Id,
  at: z.date(),
  category: ActivityCategory,
  /** Registry key: an audit action, or `stage.move` / `stage.import` for a stage event. */
  action: z.string(),
  /** The audit row's entity type, for the generic line; `Order` for stage events. */
  entityType: z.string(),
  /** Null for system work (`system` says which). */
  actor: z.object({ id: Id, name: z.string() }).nullable(),
  /** Which background actor did it, when known: `store-sync`, `operations`, `shipping`, `lumexia`. */
  system: z.string().nullable(),
  station: z.string().nullable(),
  target: ActivityTarget.nullable(),
  params: ActivityParams,
  /** Before and after, without secrets, customer details, internal ids or versions. */
  details: z.object({ before: z.unknown(), after: z.unknown() }).nullable(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

/**
 * One timeline line: a single item, or a run of repeats (same person, action and target, under
 * 5 minutes apart). `at` is the newest member's time, `firstAt` the oldest's.
 */
export const ActivityEntry = ActivityItem.extend({
  count: z.number().int().min(1),
  firstAt: z.date(),
  /** The grouped items, newest first; empty for a single item. */
  members: z.array(ActivityItem),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const OrderActivityFeed = z.object({
  /** Newest first. */
  entries: z.array(ActivityEntry),
  /** The read stopped at its row cap; older activity is left out. */
  truncated: z.boolean(),
});
export type OrderActivityFeed = z.infer<typeof OrderActivityFeed>;

/** Joins `orders` in `orders.ts`. */
export const orderActivityRoute = base
  .route({
    method: "GET",
    path: "/orders/{id}/activity",
    tags: ["Orders"],
    summary: "Everything recorded for one order, newest first, with repeats grouped",
  })
  .input(z.object({ id: Id }))
  .output(OrderActivityFeed);

/** The message an action is worded with. Flat: dots would nest in the catalog. */
export function activityMessageKey(action: string): `activity.action.${string}` {
  return `activity.action.${action.replaceAll(".", "_")}`;
}
