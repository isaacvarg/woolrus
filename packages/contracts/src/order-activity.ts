import { z } from "zod";
import { base, Id } from "./base";
import { Role } from "./me";

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

/** The statuses the summary reports (SPEC-order-activity "Stage summary"), in workflow order. */
export const SummaryStage = z.enum(["PENDING", "PICKING", "PACKING", "QA", "READY"]);
export type SummaryStage = z.infer<typeof SummaryStage>;

/** The stages people work; Pending and Ready are queues. */
export const WorkStage = z.enum(["PICKING", "PACKING", "QA"]);
export type WorkStage = z.infer<typeof WorkStage>;

/** One stay in a status, from the move that entered it to the one that left it (or now). */
export const StageInterval = z.object({
  start: z.date(),
  end: z.date(),
  /** The order is still in it: `end` is when the summary was built. */
  running: z.boolean(),
  /** `end - start`, in milliseconds. */
  statusMs: z.number().int().min(0),
  /**
   * Work stages only, else null. Waiting is start → the first action by a person; working is that
   * action → end, less idle: each gap of more than `IDLE_CUTOFF_MS` (10 min) between consecutive
   * actions by people, or from the last one to the end, is idle (SPEC-reporting decision 6).
   * The three add up to `statusMs`; with no action yet it is all waiting.
   */
  waitingMs: z.number().int().min(0).nullable(),
  workingMs: z.number().int().min(0).nullable(),
  idleMs: z.number().int().min(0).nullable(),
  firstActionAt: z.date().nullable(),
  /** A pick begun from a batch: its number and how many orders it started with. */
  batch: z
    .object({ number: z.number().int().nullable(), orders: z.number().int().nullable() })
    .nullable(),
});
export type StageInterval = z.infer<typeof StageInterval>;

export const StageSummary = z.object({
  stage: SummaryStage,
  /** The sum of the intervals' status time, in milliseconds. */
  statusMs: z.number().int().min(0),
  /** Oldest first. A repack makes a second Packing interval; a hold splits one in two. */
  intervals: z.array(StageInterval),
});
export type StageSummary = z.infer<typeof StageSummary>;

/** Time per status. Time on hold counts toward no stage. */
export const OrderActivitySummary = z.object({
  /** Every summary stage in workflow order, including ones the order hasn't reached. */
  stages: z.array(StageSummary),
  onHoldMs: z.number().int().min(0),
});
export type OrderActivitySummary = z.infer<typeof OrderActivitySummary>;

/** Someone who worked a stage: their items in its intervals. Spans include pauses. */
export const StagePerson = z.object({
  id: Id,
  name: z.string(),
  /** Timeline items; a grouped entry counts each of its members. */
  count: z.number().int().min(1),
  firstAt: z.date(),
  lastAt: z.date(),
  /** First → last action, in milliseconds. */
  spanMs: z.number().int().min(0),
});
export type StagePerson = z.infer<typeof StagePerson>;

export const StagePeople = z.object({
  stage: WorkStage,
  /** In order of their first action. */
  people: z.array(StagePerson),
});
export type StagePeople = z.infer<typeof StagePeople>;

/**
 * The four parts of the activity view a role may be shown (SPEC-order-activity "Visibility"):
 * the timeline entries, their before/after details, time per stage, and who worked each stage.
 */
export const ActivityPart = z.enum(["timeline", "details", "summary", "people"]);
export type ActivityPart = z.infer<typeof ActivityPart>;

/** Which parts one viewer gets. */
export const ActivityParts = z.object({
  timeline: z.boolean(),
  details: z.boolean(),
  summary: z.boolean(),
  people: z.boolean(),
});
export type ActivityParts = z.infer<typeof ActivityParts>;

/** The roles the setting applies to. Admins always see every part. */
export const ActivityVisibilityRole = Role.exclude(["ADMIN"]);
export type ActivityVisibilityRole = z.infer<typeof ActivityVisibilityRole>;

/**
 * `Settings.activityVisibility`: per role, the parts switched off or on. A missing role or part is
 * on, so `{}` (the default) shows every role everything.
 */
export const ActivityVisibility = z.partialRecord(
  ActivityVisibilityRole,
  z.strictObject({
    timeline: z.boolean().optional(),
    details: z.boolean().optional(),
    summary: z.boolean().optional(),
    people: z.boolean().optional(),
  }),
);
export type ActivityVisibility = z.infer<typeof ActivityVisibility>;

export const OrderActivityFeed = z.object({
  /** The parts this viewer may see. The others are absent; with `details` off every entry's `details` is null. */
  visible: ActivityParts,
  /** Time per stage (SPEC-order-activity "Stage summary"). */
  summary: OrderActivitySummary.optional(),
  /** Who worked each work stage, in workflow order. */
  people: z.array(StagePeople).optional(),
  /** Newest first. */
  entries: z.array(ActivityEntry).optional(),
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
