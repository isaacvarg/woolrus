import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";
import {
  LineAttribute,
  OrderDetail,
  OrderVersionInput,
  PickStatus,
  WorkflowStatus,
} from "./orders";
import { PICK_BATCH_MAX_ORDERS_CEILING } from "./settings";

// Picking (SPEC-picking "API"). Line writes need the order in Picking and the caller's live claim;
// they set an absolute state, so a replay is harmless and they don't carry the order's version.

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

/**
 * A batch member's standing: `live` while the order is Picking with the owner's live claim; `left`
 * once it was completed, held, cancelled, forced or taken over; `removed` when dropped on purpose
 * or moved to another batch.
 */
export const PickBatchMemberState = z.enum(["live", "left", "removed"]);
export type PickBatchMemberState = z.infer<typeof PickBatchMemberState>;

/** One slot on the cart, for the slot legend. */
export const PickBatchMember = z.object({
  slot: z.number().int(),
  orderId: Id,
  number: z.string(),
  customerName: z.string(),
  status: WorkflowStatus,
  version: z.number().int(),
  state: PickBatchMemberState,
});
export type PickBatchMember = z.infer<typeof PickBatchMember>;

export const PickBatch = z.object({
  id: Id,
  /** "Batch 42" on screen. */
  number: z.number().int(),
  owner: z.object({ id: Id, name: z.string() }),
  createdAt: z.date(),
  closedAt: z.date().nullable(),
  /** By slot. */
  members: z.array(PickBatchMember),
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
};
