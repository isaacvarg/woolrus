import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";

/** Internal by default; only customer-visible notes go to the customer in WooCommerce (FR-NOTE-08). */
export const NoteVisibility = z.enum(["INTERNAL", "CUSTOMER"]);
export type NoteVisibility = z.infer<typeof NoteVisibility>;

/** Trimmed, up to 4000 characters. Core refuses a note with nothing in it (`errors.notes.empty`). */
export const NoteContent = z.string().trim().max(4000);

/** What a note is on: the order itself, or one of its lines, packages or quality issues. */
export const NoteTargetKind = z.enum(["order", "item", "package", "issue"]);
export type NoteTargetKind = z.infer<typeof NoteTargetKind>;

export const NoteTargetInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order") }),
  z.object({ kind: z.literal("item"), id: Id }),
  z.object({ kind: z.literal("package"), id: Id }),
  z.object({ kind: z.literal("issue"), id: Id }),
]);
export type NoteTargetInput = z.infer<typeof NoteTargetInput>;

/**
 * `label` is store data, not UI text: the order number, `<line name> ×<quantity>`, the package
 * number, or the issue's description (cut at 80 characters). The UI words it per `kind`.
 */
export const NoteTarget = z.object({ kind: NoteTargetKind, id: Id, label: z.string() });
export type NoteTarget = z.infer<typeof NoteTarget>;

/** Per file, raw; the server checks it too (`errors.notes.fileTooLarge`). */
export const NOTE_FILE_MAX_BYTES = 15 * 1024 * 1024;
export const NOTE_MAX_PHOTOS = 10;
/** The whole multipart request: 10 photos and a voice memo at the file limit, plus slack. */
export const NOTE_REQUEST_MAX_BYTES = 160 * 1024 * 1024;
/** What the server accepts as a photo, judged by content (`errors.notes.fileType`). */
export const NOTE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** A voice memo's length, as the recorder measured it: the recorder stops at the cap. */
export const NOTE_VOICE_MAX_MS = 5 * 60 * 1000;

/**
 * Whole milliseconds, 1 ms to 5 minutes. Coerced because multipart over `/api/v1` sends every
 * field as text. The server only range-checks it.
 */
export const VoiceDurationMs = z.coerce.number().int().min(1).max(NOTE_VOICE_MAX_MS);

export const AttachmentKind = z.enum(["IMAGE", "VOICE"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** Metadata only: the bytes come from `url`, an app route that checks `order.read` per request. */
export const NoteAttachment = z.object({
  id: Id,
  kind: AttachmentKind,
  contentType: z.string(),
  /** The uploaded name, for display only. */
  fileName: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  url: z.string(),
  /** Photos only. */
  thumbUrl: z.string().nullable(),
});
export type NoteAttachment = z.infer<typeof NoteAttachment>;

export const Note = z.object({
  id: Id,
  orderId: Id,
  target: NoteTarget,
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
  /** Oldest first. */
  attachments: z.array(NoteAttachment),
});
export type Note = z.infer<typeof Note>;

export const CreateNoteInput = z.object({
  idempotencyKey: IdempotencyKey,
  orderId: Id,
  content: NoteContent,
  visibility: NoteVisibility.default("INTERNAL"),
  target: NoteTargetInput.default({ kind: "order" }),
  /** Sent as multipart. Checked, resized and stripped of metadata on the server. */
  photos: z.array(z.file()).optional(),
  /** One voice memo, stored as sent once its container is recognized; needs `voiceDurationMs`. */
  voice: z.file().optional(),
  voiceDurationMs: VoiceDurationMs.optional(),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

export const UpdateNoteInput = z.object({
  id: Id,
  content: NoteContent.optional(),
  visibility: NoteVisibility.optional(),
  addPhotos: z.array(z.file()).optional(),
  /** A note keeps at most one memo: to replace it, remove the old one in the same edit. */
  addVoice: z.file().optional(),
  voiceDurationMs: VoiceDurationMs.optional(),
  removeAttachmentIds: z.array(Id).optional(),
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
