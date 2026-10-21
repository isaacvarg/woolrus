import { z } from "zod";
import { base, Id } from "./base";
import { ExpectedVersion, LineAttribute, OrderDetail, PickStatus } from "./orders";

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
};
