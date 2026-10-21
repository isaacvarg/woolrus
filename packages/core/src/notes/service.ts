import type {
  CreateNoteInput,
  NoteAttachment as NoteAttachmentDto,
  Note as NoteDto,
  NoteVisibility,
  UpdateNoteInput,
} from "@woolrus/contracts";
import type { Db, DbTx, NoteAttachment, Prisma } from "@woolrus/db";
import type { ObjectStorage } from "../adapters/storage/storage";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { uuidv7 } from "../ids";
import { type Actor, assertCan, can } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import {
  discardUploads,
  NOTE_FILE_LIMITS,
  type PreparedAttachment,
  preparePhotos,
  uploadAll,
} from "./media";
import { resolveTarget, targetInclude, targetOf } from "./targets";

const MAX_CONTENT = 4000;

const noteInclude = {
  author: { select: { name: true } },
  ...targetInclude,
  attachments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.NoteInclude;
type NoteRow = Prisma.NoteGetPayload<{ include: typeof noteInclude }>;

/**
 * The contract trims and caps content already; core doesn't rely on it. A note needs text or at
 * least one attachment.
 */
function cleanContent(content: string, attachmentCount = 0): string {
  const trimmed = content.trim();
  if (trimmed.length === 0 && attachmentCount === 0) {
    throw new AppError("BAD_REQUEST", "errors.notes.empty", { content: "errors.notes.empty" });
  }
  if (trimmed.length > MAX_CONTENT) {
    throw new AppError("BAD_REQUEST", "errors.validation", { content: "errors.field.tooBig" });
  }
  return trimmed;
}

/** Customer-visible notes go to the customer, so writing one is its own permission (FR-NOTE-08). */
function assertCanWriteVisibility(actor: Actor, visibility: NoteVisibility): void {
  if (visibility === "CUSTOMER") assertCan(actor, "note.customer");
}

type Editable = { authorId: string | null; wooNoteId: number | null };

function mayEdit(actor: Actor, note: Editable): boolean {
  if (note.wooNoteId !== null || !can(actor, "note.write")) return false;
  return can(actor, "note.moderate") || (actor.userId !== null && note.authorId === actor.userId);
}

/**
 * Authorship is by user, so on a station the note belongs to whoever unlocked it (FR-NOTE-07).
 * A note already in WooCommerce is frozen for everyone, Admin included: the customer may have it.
 */
function assertMayEdit(actor: Actor, note: Editable): void {
  assertCan(actor, "note.write");
  if (note.wooNoteId !== null) throw new AppError("CONFLICT", "errors.notes.alreadySent");
  if (!mayEdit(actor, note)) throw new AppError("FORBIDDEN", "errors.notes.notAuthor");
}

/** The station each note was written on, from its create audit row (Note has no station column). */
async function stationNames(tx: DbTx, noteIds: string[]): Promise<Map<string, string>> {
  if (noteIds.length === 0) return new Map();
  const created = await tx.auditEvent.findMany({
    where: {
      entityType: "Note",
      action: "create",
      entityId: { in: noteIds },
      stationId: { not: null },
    },
    select: { entityId: true, station: { select: { name: true } } },
  });
  return new Map(
    created.flatMap((e) => (e.station ? [[e.entityId, e.station.name] as const] : [])),
  );
}

function assertPhotoCount(count: number): void {
  if (count > NOTE_FILE_LIMITS.photosPerNote) {
    throw new AppError("BAD_REQUEST", "errors.notes.tooManyPhotos", {
      photos: "errors.notes.tooManyPhotos",
    });
  }
}

/** Served by the app (`/api/attachments/{id}`), never by a storage URL (decisions.md). */
function toAttachmentDto(attachment: NoteAttachment): NoteAttachmentDto {
  const url = `/api/attachments/${attachment.id}`;
  return {
    id: attachment.id,
    kind: attachment.kind,
    contentType: attachment.contentType,
    fileName: attachment.fileName,
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    url,
    thumbUrl: attachment.thumbnailKey ? `${url}/thumb` : null,
  };
}

const attachmentRow = (noteId: string, a: PreparedAttachment) => ({
  id: a.id,
  noteId,
  kind: a.kind,
  storageKey: a.storageKey,
  thumbnailKey: a.thumbnailKey,
  contentType: a.contentType,
  fileName: a.fileName,
  sizeBytes: a.sizeBytes,
  width: a.width,
  height: a.height,
  durationMs: a.durationMs,
});

const uploadedKeys = (prepared: PreparedAttachment[]) =>
  prepared.flatMap((a) => a.files.map((f) => f.key));

/**
 * Processes and uploads files before the note transaction, then runs it. If the transaction
 * fails, or turns out to be a replay that didn't use them, the uploads are deleted (best effort).
 */
async function withUploads<T>(
  storage: ObjectStorage,
  prepare: () => Promise<PreparedAttachment[]>,
  write: (prepared: PreparedAttachment[]) => Promise<{ result: T; used: boolean }>,
): Promise<T> {
  const prepared = await prepare();
  await uploadAll(
    storage,
    prepared.flatMap((a) => a.files),
  );
  try {
    const { result, used } = await write(prepared);
    if (!used) await discardUploads(storage, uploadedKeys(prepared));
    return result;
  } catch (error) {
    await discardUploads(storage, uploadedKeys(prepared));
    throw error;
  }
}

function toNoteDto(actor: Actor, note: NoteRow, stationName: string | null): NoteDto {
  return {
    id: note.id,
    orderId: note.orderId,
    target: targetOf(note),
    content: note.content,
    visibility: note.visibility,
    authorId: note.authorId,
    authorName: note.author?.name ?? null,
    stationName,
    createdAt: note.createdAt,
    editedAt: note.editedAt,
    pushedToWooAt: note.pushedToWooAt,
    canEdit: mayEdit(actor, note),
    attachments: note.attachments.map(toAttachmentDto),
  };
}

async function loadNote(tx: DbTx, actor: Actor, id: string): Promise<NoteDto> {
  const note = await tx.note.findUniqueOrThrow({ where: { id }, include: noteInclude });
  return toNoteDto(actor, note, (await stationNames(tx, [id])).get(id) ?? null);
}

async function orderStatus(tx: DbTx, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order) throw notFound();
  return order.status;
}

const snapshot = (note: { content: string; visibility: NoteVisibility }) => ({
  content: note.content,
  visibility: note.visibility,
});

export async function listNotes(
  db: Db,
  actor: Actor,
  { orderId }: { orderId: string },
): Promise<NoteDto[]> {
  assertCan(actor, "order.read");
  return db.$transaction(async (tx) => {
    await orderStatus(tx, orderId);
    const notes = await tx.note.findMany({
      where: { orderId },
      include: noteInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const stations = await stationNames(
      tx,
      notes.map((n) => n.id),
    );
    return notes.map((note) => toNoteDto(actor, note, stations.get(note.id) ?? null));
  });
}

/**
 * Notes aren't workflow writes: any order status, no claim, no `Order.version` bump, no stage
 * event. Open pages still hear about them through `order_changed`.
 */
export async function createNote(
  db: Db,
  storage: ObjectStorage,
  actor: Actor,
  input: Omit<CreateNoteInput, "target"> & Partial<Pick<CreateNoteInput, "target">>,
): Promise<NoteDto> {
  assertCan(actor, "note.write");
  assertCanWriteVisibility(actor, input.visibility);
  const photos = input.photos ?? [];
  const content = cleanContent(input.content, photos.length);
  assertPhotoCount(photos.length);
  // A replay returns the stored note, so it shouldn't process or upload anything.
  const replay = await db.idempotentRequest.findUnique({
    where: { key: input.idempotencyKey },
    select: { key: true },
  });
  const noteId = uuidv7();

  return withUploads(
    storage,
    () => (replay ? Promise.resolve([]) : preparePhotos(noteId, photos)),
    (prepared) =>
      db.$transaction(async (tx) => {
        // Only the id is stored for replays: the stored JSON would turn the dates into strings.
        const { id } = await withIdempotency(
          tx,
          input.idempotencyKey,
          "notes.create",
          actor,
          async () => {
            const status = await orderStatus(tx, input.orderId);
            const target = await resolveTarget(
              tx,
              input.orderId,
              input.target ?? { kind: "order" },
            );
            const note = await tx.note.create({
              data: {
                id: noteId,
                orderId: input.orderId,
                ...target,
                authorId: actor.userId,
                content,
                visibility: input.visibility,
              },
            });
            await tx.noteAttachment.createMany({
              data: prepared.map((a) => attachmentRow(note.id, a)),
            });
            await recordAudit(tx, actor, {
              entityType: "Note",
              entityId: note.id,
              action: "create",
              after: {
                orderId: note.orderId,
                ...target,
                ...snapshot(note),
                attachmentIds: prepared.map((a) => a.id),
              },
            });
            await notifyOrderChanged(tx, { id: input.orderId, status });
            return { id: note.id };
          },
        );
        return { result: await loadNote(tx, actor, id), used: id === noteId };
      }),
  );
}

type NoteWithAttachments = Prisma.NoteGetPayload<{ include: { attachments: true } }>;

/**
 * Checks an update against the note as it is: author, visibility, removals that belong to it, and
 * totals that still fit. Runs before uploading and again inside the transaction.
 */
function planUpdate(actor: Actor, existing: NoteWithAttachments, input: UpdateNoteInput) {
  assertMayEdit(actor, existing);
  const removeIds = new Set(input.removeAttachmentIds ?? []);
  const known = new Set(existing.attachments.map((a) => a.id));
  if ([...removeIds].some((id) => !known.has(id))) throw notFound();
  const kept = existing.attachments.filter((a) => !removeIds.has(a.id));
  const addCount = input.addPhotos?.length ?? 0;
  assertPhotoCount(kept.filter((a) => a.kind === "IMAGE").length + addCount);
  const next = {
    content: cleanContent(input.content ?? existing.content, kept.length + addCount),
    visibility: input.visibility ?? existing.visibility,
  };
  // Editing a customer note is writing to the customer too, not only switching to it.
  assertCanWriteVisibility(actor, next.visibility);
  const removed = existing.attachments.filter((a) => removeIds.has(a.id));
  return { next, removed };
}

export async function updateNote(
  db: Db,
  storage: ObjectStorage,
  actor: Actor,
  input: UpdateNoteInput,
): Promise<NoteDto> {
  assertCan(actor, "note.write");
  const findNote = (tx: DbTx) =>
    tx.note.findUnique({ where: { id: input.id }, include: { attachments: true } });
  // Refuse before processing files: a forbidden or invalid edit uploads nothing.
  const before = await findNote(db);
  if (!before) throw notFound();
  planUpdate(actor, before, input);

  return withUploads(
    storage,
    () => preparePhotos(input.id, input.addPhotos ?? []),
    (prepared) =>
      db.$transaction(async (tx) => {
        const existing = await findNote(tx);
        if (!existing) throw notFound();
        const { next, removed } = planUpdate(actor, existing, input);
        if (
          next.content === existing.content &&
          next.visibility === existing.visibility &&
          removed.length === 0 &&
          prepared.length === 0
        ) {
          return { result: await loadNote(tx, actor, existing.id), used: true };
        }

        // The removed files stay in storage until the orphan sweep collects them.
        await tx.noteAttachment.deleteMany({ where: { id: { in: removed.map((a) => a.id) } } });
        await tx.noteAttachment.createMany({
          data: prepared.map((a) => attachmentRow(existing.id, a)),
        });
        await tx.note.update({
          where: { id: existing.id },
          data: { ...next, editedAt: new Date() },
        });
        await recordAudit(tx, actor, {
          entityType: "Note",
          entityId: existing.id,
          action: "update",
          before: snapshot(existing),
          after: {
            ...next,
            addedAttachmentIds: prepared.map((a) => a.id),
            removedAttachmentIds: removed.map((a) => a.id),
          },
        });
        await notifyOrderChanged(tx, {
          id: existing.orderId,
          status: await orderStatus(tx, existing.orderId),
        });
        return { result: await loadNote(tx, actor, existing.id), used: true };
      }),
  );
}

/** Where an attachment's bytes are, for the serving route. `order.read` is checked per fetch. */
export async function getAttachment(
  db: Db,
  actor: Actor,
  { id, variant }: { id: string; variant: "full" | "thumb" },
): Promise<{ key: string; contentType: string; fileName: string }> {
  assertCan(actor, "order.read");
  const attachment = await db.noteAttachment.findUnique({ where: { id } });
  const key = variant === "thumb" ? attachment?.thumbnailKey : attachment?.storageKey;
  if (!attachment || !key) throw notFound();
  return {
    key,
    contentType: variant === "thumb" ? "image/webp" : attachment.contentType,
    fileName: attachment.fileName,
  };
}

/** A hard delete; the audit row keeps the text. */
export async function deleteNote(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<{ id: string }> {
  assertCan(actor, "note.write");
  return db.$transaction(async (tx) => {
    const existing = await tx.note.findUnique({ where: { id } });
    if (!existing) throw notFound();
    assertMayEdit(actor, existing);
    await tx.note.delete({ where: { id } });
    await recordAudit(tx, actor, {
      entityType: "Note",
      entityId: id,
      action: "delete",
      before: { orderId: existing.orderId, authorId: existing.authorId, ...snapshot(existing) },
    });
    await notifyOrderChanged(tx, {
      id: existing.orderId,
      status: await orderStatus(tx, existing.orderId),
    });
    return { id };
  });
}
