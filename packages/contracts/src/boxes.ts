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
});
export type CreateBoxInput = z.infer<typeof CreateBoxInput>;

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
};
