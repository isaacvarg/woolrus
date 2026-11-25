import { z } from "zod";
import { base, Id, IdempotencyKey, Inches, Ounces, QueryBoolean } from "./base";

export const Box = z.object({
  id: Id,
  name: z.string(),
  lengthIn: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  maxWeightOz: z.number().nullable(),
  /** A package lighter than this trips UNDER_MIN; below the max when both are set. */
  minWeightOz: z.number().nullable(),
  tareWeightOz: z.number().nullable(),
  /** What the carrier measures; all three or none. */
  outerLengthIn: z.number().nullable(),
  outerWidthIn: z.number().nullable(),
  outerHeightIn: z.number().nullable(),
  /** The barcode posted at the box's shelf area, normalized; scanning it adds a package (SPEC-packing A1). */
  barcode: z.string().nullable(),
  /** The box's group in the pack screen's picker, or none (SPEC-packing A2). */
  groupId: Id.nullable(),
  /** A package references this box: its dimensions are locked and it can only be archived. */
  inUse: z.boolean(),
  archived: z.boolean(),
});
export type Box = z.infer<typeof Box>;

/** A box barcode as typed; stored trimmed and upper-cased, and blank clears it. */
const BoxBarcode = z.string().max(64);

export const CreateBoxInput = z.object({
  idempotencyKey: IdempotencyKey,
  name: z.string().trim().min(1).max(80),
  lengthIn: Inches,
  widthIn: Inches,
  heightIn: Inches,
  maxWeightOz: Ounces.nullable().default(null),
  minWeightOz: Ounces.nullable().default(null),
  tareWeightOz: Ounces.nullable().default(null),
  outerLengthIn: Inches.nullable().default(null),
  outerWidthIn: Inches.nullable().default(null),
  outerHeightIn: Inches.nullable().default(null),
  barcode: BoxBarcode.nullable().default(null),
  groupId: Id.nullable().default(null),
});
export type CreateBoxInput = z.infer<typeof CreateBoxInput>;

/** Only the fields present change; `null` clears min, max, tare, the barcode or the outer dimensions. */
export const UpdateBoxInput = z.object({
  id: Id,
  name: z.string().trim().min(1).max(80).optional(),
  lengthIn: Inches.optional(),
  widthIn: Inches.optional(),
  heightIn: Inches.optional(),
  maxWeightOz: Ounces.nullable().optional(),
  minWeightOz: Ounces.nullable().optional(),
  tareWeightOz: Ounces.nullable().optional(),
  outerLengthIn: Inches.nullable().optional(),
  outerWidthIn: Inches.nullable().optional(),
  outerHeightIn: Inches.nullable().optional(),
  barcode: BoxBarcode.nullable().optional(),
  /** `null` ungroups the box. Editable on a box in use and on an archived one. */
  groupId: Id.nullable().optional(),
});
export type UpdateBoxInput = z.infer<typeof UpdateBoxInput>;

export const boxes = {
  list: base
    .route({ method: "GET", path: "/boxes", tags: ["Boxes"], summary: "List box sizes" })
    .input(z.object({ includeArchived: QueryBoolean.default(false) }))
    .output(z.array(Box)),

  create: base
    .route({ method: "POST", path: "/boxes", tags: ["Boxes"], summary: "Create a box size" })
    .input(CreateBoxInput)
    .output(Box),

  archive: base
    .route({
      method: "POST",
      path: "/boxes/{id}/archive",
      tags: ["Boxes"],
      summary: "Archive a box size",
    })
    .input(z.object({ id: Id }))
    .output(Box),

  update: base
    .route({ method: "PATCH", path: "/boxes/{id}", tags: ["Boxes"], summary: "Edit a box size" })
    .input(UpdateBoxInput)
    .output(Box),

  restore: base
    .route({
      method: "POST",
      path: "/boxes/{id}/restore",
      tags: ["Boxes"],
      summary: "Restore an archived box size",
    })
    .input(z.object({ id: Id }))
    .output(Box),

  delete: base
    .route({
      method: "DELETE",
      path: "/boxes/{id}",
      tags: ["Boxes"],
      summary: "Delete an unused box size",
    })
    .input(z.object({ id: Id }))
    .output(z.object({ id: Id })),
};

/** A named set of boxes shown together in the pack screen's box picker (SPEC-packing A2). */
export const BoxGroup = z.object({
  id: Id,
  name: z.string(),
  position: z.number().int(),
  /** Active (unarchived) boxes in the group, for the Boxes page. */
  boxCount: z.number().int(),
});
export type BoxGroup = z.infer<typeof BoxGroup>;

/** Trimmed, 1–60 characters; unique ignoring case. */
const BoxGroupName = z.string().trim().min(1).max(60);

export const CreateBoxGroupInput = z.object({
  idempotencyKey: IdempotencyKey,
  name: BoxGroupName,
});
export type CreateBoxGroupInput = z.infer<typeof CreateBoxGroupInput>;

export const RenameBoxGroupInput = z.object({ id: Id, name: BoxGroupName });
export type RenameBoxGroupInput = z.infer<typeof RenameBoxGroupInput>;

export const MoveBoxGroupInput = z.object({ id: Id, direction: z.enum(["up", "down"]) });
export type MoveBoxGroupInput = z.infer<typeof MoveBoxGroupInput>;

export const boxGroups = {
  list: base
    .route({
      method: "GET",
      path: "/box-groups",
      tags: ["Boxes"],
      summary: "List box groups in order",
    })
    .output(z.array(BoxGroup)),

  create: base
    .route({
      method: "POST",
      path: "/box-groups",
      tags: ["Boxes"],
      summary: "Add a box group at the end",
    })
    .input(CreateBoxGroupInput)
    .output(BoxGroup),

  rename: base
    .route({
      method: "PATCH",
      path: "/box-groups/{id}",
      tags: ["Boxes"],
      summary: "Rename a box group",
    })
    .input(RenameBoxGroupInput)
    .output(BoxGroup),

  move: base
    .route({
      method: "POST",
      path: "/box-groups/{id}/move",
      tags: ["Boxes"],
      summary: "Move a box group up or down; returns the ordered list",
    })
    .input(MoveBoxGroupInput)
    .output(z.array(BoxGroup)),

  delete: base
    .route({
      method: "DELETE",
      path: "/box-groups/{id}",
      tags: ["Boxes"],
      summary: "Delete a box group; its boxes become ungrouped",
    })
    .input(z.object({ id: Id }))
    .output(z.object({ id: Id })),
};
