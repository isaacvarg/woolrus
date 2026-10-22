import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";
import {
  ExpectedVersion,
  LineAttribute,
  OrderDetail,
  OrderVersionInput,
  PickStatus,
  WorkflowStatus,
} from "./orders";
import { PICK_BATCH_MAX_ORDERS_CEILING } from "./settings";

// Picking (SPEC-picking "API"). Line writes need the order in Picking and the caller's live claim;
// they set an absolute state, so a replay is harmless and they don't carry the order's version.
// Out of Stock and Substituted also write a line note, so they carry an idempotency key.

/** One card on the pick screen. `quantity` is what's left to pick after voids. */
export const PickLine = z.object({
  id: Id,
  name: z.string(),
  sku: z.string().nullable(),
  imageUrl: z.string().nullable(),
  attributes: z.array(LineAttribute),
  binLocation: z.string().nullable(),
  quantity: z.number().int(),
  pickedQuantity: z.number().int(),
  pickStatus: PickStatus,
  substitutionNote: z.string().nullable(),
  pickedBy: z.object({ name: z.string() }).nullable(),
  pickedAt: z.date().nullable(),
  noteCount: z.number().int(),
});
export type PickLine = z.infer<typeof PickLine>;

const Unmet = z.object({
  messageKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const PickView = z.object({
  order: OrderDetail,
  customerNote: z.string().nullable(),
  /** Physical lines with something left to pick, in pick order. */
  lines: z.array(PickLine),
  /** Physical lines voided down to nothing: not shown, only counted. */
  voidedLines: z.number().int(),
  /** Lines picked or substituted, of `total`. */
  done: z.number().int(),
  total: z.number().int(),
  /** What the picked gate still needs; empty when the order can complete. */
  unmet: z.array(Unmet),
});
export type PickView = z.infer<typeof PickView>;

export const PickLineResult = z.object({
  line: PickLine,
  done: z.number().int(),
  total: z.number().int(),
});
export type PickLineResult = z.infer<typeof PickLineResult>;

export const PickLineInput = z.object({
  itemId: Id,
  /** Units picked so far; omitted means all of them. */
  quantity: z.number().int().min(1).max(10_000).optional(),
});
export type PickLineInput = z.infer<typeof PickLineInput>;

export const PickItemInput = z.object({ itemId: Id });
export type PickItemInput = z.infer<typeof PickItemInput>;

export const CompletePickInput = z.object({
  orderId: Id,
  expectedVersion: ExpectedVersion,
  /** Where the picker goes next: the Pending queue, the next Pending order, or packing this one. */
  after: z.enum(["queue", "next", "pack"]),
});
export type CompletePickInput = z.infer<typeof CompletePickInput>;

export const CompletePickResult = z.object({
  /** The order `after: "next"` began picking; null otherwise, or when the Pending queue was empty. */
  nextOrderId: Id.nullable(),
});
export type CompletePickResult = z.infer<typeof CompletePickResult>;

export const ScanInput = z.object({
  orderId: Id,
  /** What the scanner typed: a barcode or SKU, matched trimmed and case-insensitive. */
  code: z.string().trim().min(1).max(200),
  /** One per physical scan, so a retried request doesn't count the unit twice. */
  scanId: IdempotencyKey,
});
export type ScanInput = z.infer<typeof ScanInput>;

export const LinkBarcodeInput = z.object({
  orderItemId: Id,
  /** The scanned code; stored trimmed, matched trimmed and case-insensitive. */
  code: z.string().trim().min(1).max(200),
});
export type LinkBarcodeInput = z.infer<typeof LinkBarcodeInput>;

export const LinkBarcodeResult = z.object({
  barcode: z.string(),
  /** Where the code went: the line's variation, else its product. */
  linkedTo: z.enum(["variation", "product"]),
  /** That variation's or product's name. */
  name: z.string(),
});
export type LinkBarcodeResult = z.infer<typeof LinkBarcodeResult>;

/** `foundQuantity` is below the active quantity; core checks the upper bound against the line. */
export const MarkOutOfStockInput = z.object({
  itemId: Id,
  foundQuantity: z.number().int().min(0).max(10_000),
  note: z.string().trim().min(1).max(500),
  idempotencyKey: IdempotencyKey,
});
export type MarkOutOfStockInput = z.infer<typeof MarkOutOfStockInput>;

export const SubstituteInput = z.object({
  itemId: Id,
  /** What went in instead; kept on the line as `substitutionNote`. */
  substitute: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: IdempotencyKey,
});
export type SubstituteInput = z.infer<typeof SubstituteInput>;

/**
 * A batch member's standing: `live` while the order is Picking with the owner's live claim; `left`
 * once it was completed, held, cancelled, forced or taken over; `removed` when dropped on purpose
 * or moved to another batch.
 */
export const PickBatchMemberState = z.enum(["live", "left", "removed"]);
export type PickBatchMemberState = z.infer<typeof PickBatchMemberState>;

/**
 * Why a member left: its order moved on (`status` says where: Packing once picked, On Hold,
 * Cancelled, or anywhere a force sent it), someone else took it over, or the owner's claim expired.
 */
export const PickBatchLeft = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("status") }),
  z.object({ reason: z.literal("takenOver"), name: z.string() }),
  z.object({ reason: z.literal("claimExpired") }),
]);
export type PickBatchLeft = z.infer<typeof PickBatchLeft>;

/** One slot on the cart, for the slot legend. */
export const PickBatchMember = z.object({
  slot: z.number().int(),
  orderId: Id,
  number: z.string(),
  customerName: z.string(),
  status: WorkflowStatus,
  version: z.number().int(),
  state: PickBatchMemberState,
  /** Set when `state` is `left`. */
  left: PickBatchLeft.nullable(),
});
export type PickBatchMember = z.infer<typeof PickBatchMember>;

/** One member order's line in a group: tapping it picks that order's line. */
export const PickBatchChip = z.object({
  slot: z.number().int(),
  orderId: Id,
  number: z.string(),
  line: PickLine,
});
export type PickBatchChip = z.infer<typeof PickBatchChip>;

/**
 * One product on the shelf across the live members (variation, else product, else SKU, else name),
 * with a chip per member line: unfinished chips by slot, then done ones.
 */
export const PickBatchGroup = z.object({
  key: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  imageUrl: z.string().nullable(),
  binLocation: z.string().nullable(),
  /** Shared by every chip; null when they differ, and each chip shows its own. */
  attributes: z.array(LineAttribute).nullable(),
  /** Units across the chips, and how many of them aren't picked yet. */
  quantity: z.number().int(),
  remaining: z.number().int(),
  chips: z.array(PickBatchChip),
});
export type PickBatchGroup = z.infer<typeof PickBatchGroup>;

export const PickBatch = z.object({
  id: Id,
  /** "Batch 42" on screen. */
  number: z.number().int(),
  owner: z.object({ id: Id, name: z.string() }),
  createdAt: z.date(),
  closedAt: z.date().nullable(),
  /** By slot. */
  members: z.array(PickBatchMember),
  /** The pick list: live members' lines grouped by product, groups in pick order, done ones last. */
  groups: z.array(PickBatchGroup),
});
export type PickBatch = z.infer<typeof PickBatch>;

export const PICK_BATCH_MIN_ORDERS = 2;

/** 2 to Settings.pickBatchMaxOrders orders; the contract only enforces the setting's ceiling. */
export const CreatePickBatchInput = z.object({
  idempotencyKey: IdempotencyKey,
  orders: z
    .array(OrderVersionInput)
    .min(PICK_BATCH_MIN_ORDERS)
    .max(PICK_BATCH_MAX_ORDERS_CEILING)
    .refine((orders) => new Set(orders.map((o) => o.id)).size === orders.length, {
      message: "errors.field.invalid",
    }),
});
export type CreatePickBatchInput = z.infer<typeof CreatePickBatchInput>;

/** One order of a batch, for **Remove** (the order stays in Picking, still the picker's). */
export const PickBatchOrderInput = z.object({ id: Id, orderId: Id });
export type PickBatchOrderInput = z.infer<typeof PickBatchOrderInput>;

/** Orders to complete picking for, each moved on its own (SPEC-picking "Complete"). */
export const CompletePickBatchInput = z.object({
  id: Id,
  orders: z
    .array(OrderVersionInput)
    .min(1)
    .max(PICK_BATCH_MAX_ORDERS_CEILING)
    .refine((orders) => new Set(orders.map((o) => o.id)).size === orders.length, {
      message: "errors.field.invalid",
    }),
});
export type CompletePickBatchInput = z.infer<typeof CompletePickBatchInput>;

/** One order's outcome: moved to Packing, or why not (with the picked gate's unmet list). */
export const PickBatchCompletion = z.discriminatedUnion("moved", [
  z.object({ orderId: Id, moved: z.literal(true) }),
  z.object({
    orderId: Id,
    moved: z.literal(false),
    messageKey: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    unmet: z.array(Unmet),
  }),
]);
export type PickBatchCompletion = z.infer<typeof PickBatchCompletion>;

export const CompletePickBatchResult = z.object({
  /** In the order asked. */
  results: z.array(PickBatchCompletion),
  /** The batch afterwards; closed when nothing in it is live any more. */
  batch: PickBatch,
});
export type CompletePickBatchResult = z.infer<typeof CompletePickBatchResult>;

/** An order the actor is picking, for **My picks**. */
export const MyPickOrder = z.object({
  id: Id,
  number: z.string(),
  customerName: z.string(),
  priority: z.number().int(),
  claimedAt: z.date(),
});
export type MyPickOrder = z.infer<typeof MyPickOrder>;

export const MyPicks = z.object({
  /** The actor's open batch, if any. */
  batch: PickBatch.nullable(),
  /** The actor's live-claimed orders in Picking that aren't live members of that batch. */
  orders: z.array(MyPickOrder),
});
export type MyPicks = z.infer<typeof MyPicks>;

const tags = ["Picking"];

export const picking = {
  view: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/pick",
      tags,
      summary: "The pick screen: lines in pick order, progress and what's still missing",
    })
    .input(z.object({ orderId: Id }))
    .output(PickView),
  pickLine: base
    .route({
      method: "POST",
      path: "/order-items/{itemId}/pick",
      tags,
      summary: "Mark a line picked, or record how many units are picked so far",
    })
    .input(PickLineInput)
    .output(PickLineResult),
  unpickLine: base
    .route({
      method: "POST",
      path: "/order-items/{itemId}/unpick",
      tags,
      summary: "Put a line back to not picked",
    })
    .input(PickItemInput)
    .output(PickLineResult),
  complete: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/complete-pick",
      tags,
      summary:
        "Complete picking, then go back to the queue, begin the next order, or pack this one",
    })
    .input(CompletePickInput)
    .output(CompletePickResult),
  scan: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/scan",
      tags,
      summary: "Count one scanned unit on the first line of the order it matches",
    })
    .input(ScanInput)
    .output(PickLineResult),
  linkBarcode: base
    .route({
      method: "POST",
      path: "/order-items/{orderItemId}/link-barcode",
      tags,
      summary: "Make a scanned code the barcode of the line's variation, else its product (Admin)",
    })
    .input(LinkBarcodeInput)
    .output(LinkBarcodeResult),
  markOutOfStock: base
    .route({
      method: "POST",
      path: "/order-items/{itemId}/out-of-stock",
      tags,
      summary: "Mark a line Out of Stock with how many were found and a note",
    })
    .input(MarkOutOfStockInput)
    .output(PickLineResult),
  substitute: base
    .route({
      method: "POST",
      path: "/order-items/{itemId}/substitute",
      tags,
      summary: "Mark a line Substituted with what went in instead; it counts as picked",
    })
    .input(SubstituteInput)
    .output(PickLineResult),
  myPicks: base
    .route({
      method: "GET",
      path: "/me/picks",
      tags,
      summary: "My open pick batch and the orders I'm picking",
    })
    .output(MyPicks),
};

export const pickBatches = {
  create: base
    .route({
      method: "POST",
      path: "/pick-batches",
      tags,
      summary: "Begin picking several orders together as one batch, all or nothing",
    })
    .input(CreatePickBatchInput)
    .output(PickBatch),
  get: base
    .route({ method: "GET", path: "/pick-batches/{id}", tags, summary: "A pick batch" })
    .input(z.object({ id: Id }))
    .output(PickBatch),
  complete: base
    .route({
      method: "POST",
      path: "/pick-batches/{id}/complete",
      tags,
      summary: "Complete picking for some of a batch's orders, each on its own",
    })
    .input(CompletePickBatchInput)
    .output(CompletePickBatchResult),
  removeOrder: base
    .route({
      method: "POST",
      path: "/pick-batches/{id}/remove-order",
      tags,
      summary: "Take an order out of the batch; it stays in Picking, still yours",
    })
    .input(PickBatchOrderInput)
    .output(PickBatch),
  finish: base
    .route({
      method: "POST",
      path: "/pick-batches/{id}/finish",
      tags,
      summary: "Finish the batch; its orders stay where they are",
    })
    .input(z.object({ id: Id }))
    .output(PickBatch),
};
