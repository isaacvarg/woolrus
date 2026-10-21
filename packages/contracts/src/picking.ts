import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";
import { LineAttribute, OrderDetail, PickStatus } from "./orders";

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
};
