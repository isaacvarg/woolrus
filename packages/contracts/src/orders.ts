import { z } from "zod";
import { base, Id } from "./base";

// Order workflow (SPEC-workflow "API"). Status moves and claims are server-owned: every mutation
// carries the version the client saw, so a replay or a race fails with errors.workflow.stale.

export const WorkflowStatus = z.enum([
  "PENDING",
  "PICKING",
  "PACKING",
  "QA",
  "READY",
  "COMPLETED",
  "ON_HOLD",
  "CANCELLED",
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

/** The holder of a live claim; an expired claim reads as null. */
export const OrderClaim = z.object({ userId: Id, userName: z.string(), at: z.date() });
export type OrderClaim = z.infer<typeof OrderClaim>;

/**
 * One order as the floor sees it. Mutations return it so the client can update without a refetch.
 * The order detail read (T11) extends it with lines, addresses, packages and allowed actions.
 */
export const OrderDetail = z.object({
  id: Id,
  number: z.string(),
  customerName: z.string(),
  orderedAt: z.date(),
  shippingMethod: z.string().nullable(),
  status: WorkflowStatus,
  statusChangedAt: z.date(),
  priority: z.number().int(),
  holdReason: z.string().nullable(),
  heldFromStatus: WorkflowStatus.nullable(),
  claim: OrderClaim.nullable(),
  completedAt: z.date().nullable(),
  externalChange: z.boolean(),
  version: z.number().int(),
});
export type OrderDetail = z.infer<typeof OrderDetail>;

const ExpectedVersion = z.number().int().min(1);

/** A free-text reason kept in the order's history (hold, cancel, force). */
export const Reason = z.string().trim().min(1).max(500);

export const OrderVersionInput = z.object({ id: Id, expectedVersion: ExpectedVersion });
export type OrderVersionInput = z.infer<typeof OrderVersionInput>;

export const OrderReasonInput = OrderVersionInput.extend({ reason: Reason });
export type OrderReasonInput = z.infer<typeof OrderReasonInput>;

export const ForceStatusInput = OrderReasonInput.extend({ to: WorkflowStatus });
export type ForceStatusInput = z.infer<typeof ForceStatusInput>;

/** `confirm` must be true: the UI asks first, naming the current holder. */
export const TakeOverInput = OrderVersionInput.extend({
  confirm: z.literal(true, "errors.workflow.takeOverConfirm"),
});
export type TakeOverInput = z.infer<typeof TakeOverInput>;

export const CLAIM_MANY_MAX = 50;

export const ClaimManyInput = z.object({
  orders: z
    .array(z.object({ id: Id, expectedVersion: ExpectedVersion }))
    .min(1)
    .max(CLAIM_MANY_MAX)
    .refine((orders) => new Set(orders.map((o) => o.id)).size === orders.length, {
      message: "errors.field.invalid",
    }),
});
export type ClaimManyInput = z.infer<typeof ClaimManyInput>;

/** The statuses that have a floor queue: the five stages, plus On Hold. */
export const QueueStage = WorkflowStatus.extract([
  "PENDING",
  "PICKING",
  "PACKING",
  "QA",
  "READY",
  "ON_HOLD",
]);
export type QueueStage = z.infer<typeof QueueStage>;

export const QUEUE_PAGE_MAX = 100;

export const QueueInput = z.object({
  stage: QueueStage,
  /** Order number prefix ("#" optional) or part of the customer's name. */
  search: z.string().trim().max(100).optional(),
  /** `nextCursor` of the previous page. Opaque. */
  cursor: z.string().max(500).optional(),
  // Coerced: over /api/v1 it arrives as a query string.
  limit: z.coerce.number().int().min(1).max(QUEUE_PAGE_MAX).default(50),
});
export type QueueInput = z.input<typeof QueueInput>;

/** One queue row. Sorted by priority, then oldest order first. */
export const QueueRow = z.object({
  id: Id,
  number: z.string(),
  customerName: z.string(),
  /** Active units of physical lines (voids and non-physical lines like Rush Order excluded). */
  itemCount: z.number().int(),
  priority: z.number().int(),
  orderedAt: z.date(),
  stageEnteredAt: z.date(),
  /** Time in stage is past `Settings.stageSlaMinutes` for this stage. */
  slaBreached: z.boolean(),
  claim: OrderClaim.nullable(),
  externalChange: z.boolean(),
  holdReason: z.string().nullable(),
  heldFromStatus: WorkflowStatus.nullable(),
  version: z.number().int(),
});
export type QueueRow = z.infer<typeof QueueRow>;

export const QueuePage = z.object({ rows: z.array(QueueRow), nextCursor: z.string().nullable() });
export type QueuePage = z.infer<typeof QueuePage>;

/** Orders in each queue, for the nav. */
export const QueueCounts = z.record(QueueStage, z.number().int());
export type QueueCounts = z.infer<typeof QueueCounts>;

const tags = ["Orders"];

const move = (path: string, summary: string) =>
  base
    .route({ method: "POST", path: `/orders/{id}/${path}`, tags, summary })
    .input(OrderVersionInput)
    .output(OrderDetail);

const moveWithReason = (path: string, summary: string) =>
  base
    .route({ method: "POST", path: `/orders/{id}/${path}`, tags, summary })
    .input(OrderReasonInput)
    .output(OrderDetail);

export const orders = {
  queue: base
    .route({
      method: "GET",
      path: "/orders/queue/{stage}",
      tags,
      summary: "One stage's queue, most urgent first, keyset-paged",
    })
    .input(QueueInput)
    .output(QueuePage),
  counts: base
    .route({ method: "GET", path: "/orders/counts", tags, summary: "Orders in each queue" })
    .output(QueueCounts),

  beginPicking: move("begin-picking", "Begin picking a Pending order and claim it"),
  completePicking: move("complete-picking", "Finish picking; refused while lines are unpicked"),
  completePacking: move("complete-packing", "Finish packing; refused until every unit is packed"),
  completeQa: move("complete-qa", "Finish QA; refused until every package is verified and labeled"),
  hold: moveWithReason("hold", "Put an order on hold"),
  resume: move("resume", "Resume a held order at the stage it was held from"),
  cancel: moveWithReason("cancel", "Cancel an order"),
  forceStatus: base
    .route({
      method: "POST",
      path: "/orders/{id}/force-status",
      tags,
      summary: "Move an order to any status, skipping gates (admin)",
    })
    .input(ForceStatusInput)
    .output(OrderDetail),

  claim: move("claim", "Claim an order"),
  release: base
    .route({ method: "POST", path: "/orders/{id}/release", tags, summary: "Release a claim" })
    .input(z.object({ id: Id }))
    .output(OrderDetail),
  takeOver: base
    .route({
      method: "POST",
      path: "/orders/{id}/take-over",
      tags,
      summary: "Take over an order someone else has claimed",
    })
    .input(TakeOverInput)
    .output(OrderDetail),
  claimMany: base
    .route({
      method: "POST",
      path: "/orders/claim",
      tags,
      summary: "Claim several orders, all or nothing",
    })
    .input(ClaimManyInput)
    .output(z.array(OrderDetail)),
};
