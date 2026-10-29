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
 * `OrderView` (the detail page) extends it with lines, addresses, packages and allowed actions.
 */
export const OrderDetail = z.object({
  id: Id,
  number: z.string(),
  customerName: z.string(),
  /** Customer details were anonymized: `customerName` is empty and the UI says so. */
  piiRedacted: z.boolean(),
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
  /** Has lines, and every one is voided down to nothing: the order can't leave Picking, Packing or QA. */
  allVoided: z.boolean(),
  version: z.number().int(),
});
export type OrderDetail = z.infer<typeof OrderDetail>;

export const ExpectedVersion = z.number().int().min(1);

/** A free-text reason kept in the order's history (hold, cancel, force). */
export const Reason = z.string().trim().min(1).max(500);

export const OrderVersionInput = z.object({ id: Id, expectedVersion: ExpectedVersion });
export type OrderVersionInput = z.infer<typeof OrderVersionInput>;

export const OrderReasonInput = OrderVersionInput.extend({ reason: Reason });
export type OrderReasonInput = z.infer<typeof OrderReasonInput>;

export const DismissExternalChangeInput = OrderReasonInput;
export type DismissExternalChangeInput = z.infer<typeof DismissExternalChangeInput>;

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

export const QualityIssueSeverity = z.enum(["MINOR", "MAJOR", "CRITICAL"]);
export type QualityIssueSeverity = z.infer<typeof QualityIssueSeverity>;

/** One queue row. Sorted by priority, then oldest order first. */
export const QueueRow = z.object({
  id: Id,
  number: z.string(),
  customerName: z.string(),
  /** Customer details were anonymized: `customerName` is empty and the UI says so. */
  piiRedacted: z.boolean(),
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
  /** Notes on the order, any target (FR-NOTE-05). */
  noteCount: z.number().int(),
  /** Quality issues still open on the order, and the worst severity among them (null when none). */
  openIssueCount: z.number().int(),
  topOpenSeverity: QualityIssueSeverity.nullable(),
  /** Voids that are neither undone nor resolved yet. */
  unresolvedVoidCount: z.number().int(),
});
export type QueueRow = z.infer<typeof QueueRow>;

export const QueuePage = z.object({ rows: z.array(QueueRow), nextCursor: z.string().nullable() });
export type QueuePage = z.infer<typeof QueuePage>;

/** Orders in each queue, for the nav. */
export const QueueCounts = z.record(QueueStage, z.number().int());
export type QueueCounts = z.infer<typeof QueueCounts>;

/** What the caller may do to an order right now; the UI shows only these buttons. */
export const OrderAction = z.enum([
  "beginPicking",
  "completePicking",
  "completePacking",
  "completeQa",
  "hold",
  "resume",
  "cancel",
  "forceStatus",
  "claim",
  "release",
  "takeOver",
  /** Apply or dismiss a change made in the store (SPEC-store-sync "Reviewing a flagged change"). */
  "resolveExternalChange",
]);
export type OrderAction = z.infer<typeof OrderAction>;

/** A WooCommerce address as stored on the order. Every field may be missing. */
export const OrderAddress = z.object({
  name: z.string().optional(),
  company: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});
export type OrderAddress = z.infer<typeof OrderAddress>;

export const PickStatus = z.enum(["PENDING", "PICKED", "OUT_OF_STOCK", "SUBSTITUTED"]);
export type PickStatus = z.infer<typeof PickStatus>;

/** A variation attribute ("Size: 8oz") or a customer's product option ("Specific Delivery Window?: No"). */
export const LineAttribute = z.object({ name: z.string(), option: z.string() });
export type LineAttribute = z.infer<typeof LineAttribute>;

export const OrderLine = z.object({
  id: Id,
  name: z.string(),
  sku: z.string().nullable(),
  imageUrl: z.string().nullable(),
  quantity: z.number().int(),
  /** Quantity minus voids that aren't undone. */
  activeQuantity: z.number().int(),
  /** False for lines nobody handles on the floor (Rush Order). */
  physical: z.boolean(),
  pickStatus: PickStatus,
  pickedQuantity: z.number().int(),
  substitutionNote: z.string().nullable(),
  /** Who picked the line and when (FR-WF-04); null until it's picked. */
  pickedBy: z.object({ name: z.string() }).nullable(),
  pickedAt: z.date().nullable(),
  /** What the floor needs to pick the right thing: size, pack, and options chosen at checkout. */
  attributes: z.array(LineAttribute),
  /** Notes on this line. */
  noteCount: z.number().int(),
});
export type OrderLine = z.infer<typeof OrderLine>;

/** Where in the process something happened; stored on voids and quality issues, never typed by the actor. */
export const FulfillmentStage = z.enum([
  "INTAKE",
  "PICKING",
  "PACKING",
  "QA",
  "SHIPPING",
  "CUSTOMER",
]);
export type FulfillmentStage = z.infer<typeof FulfillmentStage>;

export const VoidResolution = z.enum(["HANDLED_MANUALLY", "REFUNDED", "LINE_EDITED"]);
export type VoidResolution = z.infer<typeof VoidResolution>;

/** A void as the order detail and the voids page show it, with its undone and resolved state. */
export const ItemVoidView = z.object({
  id: Id,
  orderId: Id,
  orderItemId: Id,
  lineName: z.string(),
  sku: z.string().nullable(),
  quantity: z.number().int(),
  reason: z.string(),
  stage: FulfillmentStage,
  voidedBy: z.object({ name: z.string() }).nullable(),
  voidedAt: z.date(),
  undoneAt: z.date().nullable(),
  undoneBy: z.object({ name: z.string() }).nullable(),
  resolvedAt: z.date().nullable(),
  resolution: VoidResolution.nullable(),
  resolutionNotes: z.string().nullable(),
  resolvedBy: z.object({ name: z.string() }).nullable(),
});
export type ItemVoidView = z.infer<typeof ItemVoidView>;

export const QualityIssueType = z.enum([
  "WRONG_ITEM",
  "DAMAGED_ITEM",
  "MISSING_ITEM",
  "WRONG_QUANTITY",
  "PACKAGING_DAMAGE",
  "LABELING_ERROR",
  "WRONG_BOX_SIZE",
  "OTHER",
]);
export type QualityIssueType = z.infer<typeof QualityIssueType>;

export const QualityIssueStatus = z.enum(["OPEN", "RESOLVED", "DISMISSED"]);
export type QualityIssueStatus = z.infer<typeof QualityIssueStatus>;

/** A quality issue as the order detail's Exceptions panel shows it. */
export const QualityIssueView = z.object({
  id: Id,
  orderId: Id,
  orderItemId: Id.nullable(),
  /** Name of the line the issue is on, if any. */
  lineName: z.string().nullable(),
  packageId: Id.nullable(),
  packageNumber: z.number().int().nullable(),
  type: QualityIssueType,
  severity: QualityIssueSeverity,
  status: QualityIssueStatus,
  description: z.string(),
  discoveredStage: FulfillmentStage,
  originStage: FulfillmentStage.nullable(),
  customerReported: z.boolean(),
  reporterId: Id.nullable(),
  reporter: z.object({ name: z.string() }).nullable(),
  /** Inferred from the origin stage, or chosen by a person (`responsibleManual`). */
  responsible: z.object({ id: Id, name: z.string() }).nullable(),
  responsibleManual: z.boolean(),
  resolutionNotes: z.string().nullable(),
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
  /** Notes (photos, voice memos) on the issue. */
  noteCount: z.number().int(),
});
export type QualityIssueView = z.infer<typeof QualityIssueView>;

export const OrderPackageSummary = z.object({
  id: Id,
  number: z.number().int(),
  boxName: z.string().nullable(),
  /** Custom outer dimensions; null when the package has a box. */
  dimensions: z
    .object({ lengthIn: z.number(), widthIn: z.number(), heightIn: z.number() })
    .nullable(),
  weightOz: z.number().nullable(),
  units: z.number().int(),
  /** What is in it, per order line: a line split across boxes appears in each. */
  items: z.array(z.object({ orderItemId: Id, name: z.string(), quantity: z.number().int() })),
  /** A label exists or may exist at the carrier. */
  liveLabel: z.boolean(),
  /** Notes on this package. */
  noteCount: z.number().int(),
});
export type OrderPackageSummary = z.infer<typeof OrderPackageSummary>;

const change = <T extends z.ZodType>(value: T) => z.object({ from: value, to: value });

const ChangedLine = z.object({
  wooLineItemId: z.number().int(),
  name: z.string(),
  sku: z.string().nullable(),
  quantity: z.number().int(),
});

/**
 * What the store changed since Woolrus last took its version (old → new per field). `refunds` is
 * the refunded total in cents. `status` is never applied by Apply.
 */
export const ExternalChangeDiff = z.object({
  status: change(z.string()).optional(),
  shippingAddress: change(OrderAddress).optional(),
  billingAddress: change(OrderAddress).optional(),
  customerNote: change(z.string().nullable()).optional(),
  shippingMethod: change(z.string().nullable()).optional(),
  customer: change(z.object({ name: z.string(), email: z.string().nullable() })).optional(),
  refunds: change(z.number().int()).optional(),
  lines: z.object({
    added: z.array(ChangedLine),
    removed: z.array(ChangedLine),
    quantity: z.array(
      z.object({
        wooLineItemId: z.number().int(),
        name: z.string(),
        from: z.number().int(),
        to: z.number().int(),
      }),
    ),
  }),
});
export type ExternalChangeDiff = z.infer<typeof ExternalChangeDiff>;

/** A flagged store change. The store's raw data stays on the server. */
export const ExternalChange = z.object({ detectedAt: z.date(), diff: ExternalChangeDiff });
export type ExternalChange = z.infer<typeof ExternalChange>;

/** The order detail page: the order plus what's in it and what the caller may do. */
export const OrderView = OrderDetail.extend({
  externalChange: ExternalChange.nullable(),
  customerEmail: z.string().nullable(),
  customerNote: z.string().nullable(),
  shippingAddress: OrderAddress,
  billingAddress: OrderAddress,
  lines: z.array(OrderLine),
  packages: z.array(OrderPackageSummary),
  /** Every void on the order, newest first, including undone and resolved ones. */
  voids: z.array(ItemVoidView),
  /** Every quality issue on the order, open first, then newest. */
  issues: z.array(QualityIssueView),
  allowedActions: z.array(OrderAction),
});
export type OrderView = z.infer<typeof OrderView>;

/** One entry of an order's history: a status change, or a claim moving between people. */
export const OrderHistoryEntry = z.object({
  id: Id,
  at: z.date(),
  type: z.enum(["stage", "claim", "takeOver", "release"]),
  fromStatus: WorkflowStatus.nullable(),
  toStatus: WorkflowStatus.nullable(),
  reason: z.string().nullable(),
  /** Null for store-sync moves (`bySystem`). */
  actorName: z.string().nullable(),
  /** Made by store sync, not a person: shown as "Store sync". */
  bySystem: z.boolean(),
  stationName: z.string().nullable(),
  /** Takeovers: whose claim was taken. */
  previousHolderName: z.string().nullable(),
});
export type OrderHistoryEntry = z.infer<typeof OrderHistoryEntry>;

export const ORDER_LIST_PAGE_MAX = 100;

export const OrderListSort = z.enum(["number", "orderedAt", "customer", "status", "priority"]);
export type OrderListSort = z.infer<typeof OrderListSort>;

export const OrderListInput = z.object({
  /** Order number prefix ("#" optional) or part of the customer's name. */
  search: z.string().trim().max(100).optional(),
  // A single status arrives over /api/v1 as a plain string.
  statuses: z
    .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(WorkflowStatus).max(8))
    .optional(),
  sort: OrderListSort.default("orderedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(ORDER_LIST_PAGE_MAX).default(50),
});
export type OrderListInput = z.input<typeof OrderListInput>;

export const OrderListRow = z.object({
  id: Id,
  number: z.string(),
  customerName: z.string(),
  /** Customer details were anonymized: `customerName` is empty and the UI says so. */
  piiRedacted: z.boolean(),
  status: WorkflowStatus,
  priority: z.number().int(),
  orderedAt: z.date(),
  statusChangedAt: z.date(),
  externalChange: z.boolean(),
  /** Notes on the order, any target (FR-NOTE-05). */
  noteCount: z.number().int(),
});
export type OrderListRow = z.infer<typeof OrderListRow>;

export const OrderListPage = z.object({
  rows: z.array(OrderListRow),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type OrderListPage = z.infer<typeof OrderListPage>;

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
  list: base
    .route({
      method: "GET",
      path: "/orders",
      tags,
      summary: "All orders: search, status filter, sort, offset paging",
    })
    .input(OrderListInput)
    .output(OrderListPage),
  get: base
    .route({
      method: "GET",
      path: "/orders/{id}",
      tags,
      summary: "One order, with allowed actions",
    })
    .input(z.object({ id: Id }))
    .output(OrderView),
  history: base
    .route({
      method: "GET",
      path: "/orders/{id}/history",
      tags,
      summary: "Stage changes and claim moves, newest first",
    })
    .input(z.object({ id: Id }))
    .output(z.array(OrderHistoryEntry)),

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

  externalChange: {
    apply: move(
      "external-change/apply",
      "Apply a change made in the store; refused if it would undo floor work (admin)",
    ),
    dismiss: base
      .route({
        method: "POST",
        path: "/orders/{id}/external-change/dismiss",
        tags,
        summary: "Dismiss a change made in the store, with a reason (admin)",
      })
      .input(DismissExternalChangeInput)
      .output(OrderDetail),
  },

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
