import { z } from "zod";
import { base, Id } from "./base";
import { ItemVoidView, PickStatus, VoidResolution, WorkflowStatus } from "./orders";

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

export const VOID_NOTES_MAX = 1000;
export const VOID_RESOLVE_MAX = 50;

/** What the admin did in WooCommerce by hand; nothing is sent there (FR-VOID-04). */
export const ResolveVoidsInput = z.object({
  voidIds: z.array(Id).min(1).max(VOID_RESOLVE_MAX),
  resolution: VoidResolution,
  notes: z.string().trim().min(1).max(VOID_NOTES_MAX),
});
export type ResolveVoidsInput = z.infer<typeof ResolveVoidsInput>;

export const ResolveVoidsResult = z.object({ resolved: z.number().int() });
export type ResolveVoidsResult = z.infer<typeof ResolveVoidsResult>;

export const VoidListStatus = z.enum(["unresolved", "resolved", "all"]);
export type VoidListStatus = z.infer<typeof VoidListStatus>;

export const VoidListInput = z.object({
  status: VoidListStatus.default("unresolved"),
  /** Order-number prefix or part of the customer's name. */
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type VoidListInput = z.input<typeof VoidListInput>;

/** An order and its voids matching the list's status, newest first. */
export const VoidOrderGroup = z.object({
  order: z.object({
    id: Id,
    number: z.string(),
    customerName: z.string(),
    status: WorkflowStatus,
  }),
  voids: z.array(ItemVoidView),
});
export type VoidOrderGroup = z.infer<typeof VoidOrderGroup>;

export const VoidListPage = z.object({
  groups: z.array(VoidOrderGroup),
  nextCursor: z.string().nullable(),
});
export type VoidListPage = z.infer<typeof VoidListPage>;

/** For the nav badge: orders with at least one unresolved void. */
export const VoidCounts = z.object({ unresolvedOrders: z.number().int() });
export type VoidCounts = z.infer<typeof VoidCounts>;

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
  resolve: base
    .route({
      method: "POST",
      path: "/voids/resolve",
      tags,
      summary: "Record what an admin did in WooCommerce about voids, all or nothing",
    })
    .input(ResolveVoidsInput)
    .output(ResolveVoidsResult),
  list: base
    .route({ method: "GET", path: "/voids", tags, summary: "Orders with voids, newest first" })
    .input(VoidListInput)
    .output(VoidListPage),
  counts: base
    .route({ method: "GET", path: "/voids/counts", tags, summary: "Orders with unresolved voids" })
    .output(VoidCounts),
};
