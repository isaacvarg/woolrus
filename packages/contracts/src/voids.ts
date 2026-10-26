import { z } from "zod";
import { base, Id } from "./base";
import { ItemVoidView, PickStatus } from "./orders";

// Item voids (SPEC-exceptions "Void rules"). Voiding takes no claim and doesn't bump the order's
// version, so these inputs carry no `expectedVersion`.

const tags = ["Voids"];

export const VOID_REASON_MAX = 500;

export const VoidItemInput = z.object({
  orderId: Id,
  orderItemId: Id,
  /** 1 to the line's active quantity; core checks the upper bound under the order lock. */
  quantity: z.number().int().min(1).max(10_000),
  reason: z.string().trim().min(1).max(VOID_REASON_MAX),
});
export type VoidItemInput = z.infer<typeof VoidItemInput>;

export const UndoVoidInput = z.object({ voidId: Id });
export type UndoVoidInput = z.infer<typeof UndoVoidInput>;

/** The line as the pick and pack screens need it after a void or an undo, in one round trip. */
export const VoidedLine = z.object({
  id: Id,
  quantity: z.number().int(),
  activeQuantity: z.number().int(),
  pickStatus: PickStatus,
  /** Units of the line in packages, all packages together. */
  packedQuantity: z.number().int(),
});
export type VoidedLine = z.infer<typeof VoidedLine>;

export const VoidResult = z.object({ line: VoidedLine, void: ItemVoidView });
export type VoidResult = z.infer<typeof VoidResult>;

export const voids = {
  void: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/voids",
      tags,
      summary: "Void a line, or part of it, with a reason",
    })
    .input(VoidItemInput)
    .output(VoidResult),
  undo: base
    .route({
      method: "POST",
      path: "/voids/{voidId}/undo",
      tags,
      summary: "Undo a void that hasn't been resolved",
    })
    .input(UndoVoidInput)
    .output(VoidResult),
};
