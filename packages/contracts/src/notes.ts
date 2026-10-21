import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";

/** Internal by default; only customer-visible notes go to the customer in WooCommerce (FR-NOTE-08). */
export const NoteVisibility = z.enum(["INTERNAL", "CUSTOMER"]);
export type NoteVisibility = z.infer<typeof NoteVisibility>;

/** Trimmed, up to 4000 characters. Core refuses a note with nothing in it (`errors.notes.empty`). */
export const NoteContent = z.string().trim().max(4000);

export const Note = z.object({
  id: Id,
  orderId: Id,
  content: z.string(),
  visibility: NoteVisibility,
  /** Null once the author's account is gone. */
  authorId: Id.nullable(),
  authorName: z.string().nullable(),
  /** The station it was written on, if any. */
  stationName: z.string().nullable(),
  createdAt: z.date(),
  editedAt: z.date().nullable(),
  pushedToWooAt: z.date().nullable(),
  /** Whether the caller may edit and delete it: its author, or a moderator (FR-NOTE-07). */
  canEdit: z.boolean(),
});
export type Note = z.infer<typeof Note>;

export const CreateNoteInput = z.object({
  idempotencyKey: IdempotencyKey,
  orderId: Id,
  content: NoteContent,
  visibility: NoteVisibility.default("INTERNAL"),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

export const UpdateNoteInput = z.object({
  id: Id,
  content: NoteContent.optional(),
  visibility: NoteVisibility.optional(),
});
export type UpdateNoteInput = z.infer<typeof UpdateNoteInput>;

const tags = ["Notes"];

// Notes aren't workflow writes: any order status, no claim, no version.
export const notes = {
  list: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/notes",
      tags,
      summary: "List an order's notes",
    })
    .input(z.object({ orderId: Id }))
    .output(z.array(Note)),

  create: base
    .route({ method: "POST", path: "/orders/{orderId}/notes", tags, summary: "Add a note" })
    .input(CreateNoteInput)
    .output(Note),

  update: base
    .route({ method: "PATCH", path: "/notes/{id}", tags, summary: "Edit a note" })
    .input(UpdateNoteInput)
    .output(Note),

  delete: base
    .route({ method: "DELETE", path: "/notes/{id}", tags, summary: "Delete a note" })
    .input(z.object({ id: Id }))
    .output(z.object({ id: Id })),
};
