import { z } from "zod";
import { base, Id, IdempotencyKey, Inches, Ounces } from "./base";

export const Box = z.object({
  id: Id,
  name: z.string(),
  lengthIn: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  maxWeightOz: z.number().nullable(),
  tareWeightOz: z.number().nullable(),
  /** What the carrier measures; all three or none. */
  outerLengthIn: z.number().nullable(),
  outerWidthIn: z.number().nullable(),
  outerHeightIn: z.number().nullable(),
  /** A package references this box: its dimensions are locked and it can only be archived. */
  inUse: z.boolean(),
  archived: z.boolean(),
});
export type Box = z.infer<typeof Box>;

export const CreateBoxInput = z.object({
  idempotencyKey: IdempotencyKey,
  name: z.string().trim().min(1).max(80),
  lengthIn: Inches,
  widthIn: Inches,
  heightIn: Inches,
  maxWeightOz: Ounces.nullable().default(null),
  tareWeightOz: Ounces.nullable().default(null),
  outerLengthIn: Inches.nullable().default(null),
  outerWidthIn: Inches.nullable().default(null),
  outerHeightIn: Inches.nullable().default(null),
});
export type CreateBoxInput = z.infer<typeof CreateBoxInput>;

/** Only the fields present change; `null` clears max, tare or the outer dimensions. */
export const UpdateBoxInput = z.object({
  id: Id,
  name: z.string().trim().min(1).max(80).optional(),
  lengthIn: Inches.optional(),
  widthIn: Inches.optional(),
  heightIn: Inches.optional(),
  maxWeightOz: Ounces.nullable().optional(),
  tareWeightOz: Ounces.nullable().optional(),
  outerLengthIn: Inches.nullable().optional(),
  outerWidthIn: Inches.nullable().optional(),
  outerHeightIn: Inches.nullable().optional(),
});
export type UpdateBoxInput = z.infer<typeof UpdateBoxInput>;

export const boxes = {
  list: base
    .route({ method: "GET", path: "/boxes", tags: ["Boxes"], summary: "List box sizes" })
    .input(z.object({ includeArchived: z.boolean().default(false) }))
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
