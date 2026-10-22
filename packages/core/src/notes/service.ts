import {
  type CreateNoteInput,
  NOTE_VOICE_MAX_MS,
  type NoteAttachment as NoteAttachmentDto,
  type Note as NoteDto,
  type NoteVisibility,
  type UpdateNoteInput,
} from "@woolrus/contracts";
import type { Db, DbTx, NoteAttachment, Prisma } from "@woolrus/db";
import type { ObjectStorage } from "../adapters/storage/storage";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { uuidv7 } from "../ids";
import { type Actor, assertCan, can } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import { enqueueFileDeletion } from "./files";
import {
  discardUploads,
  NOTE_FILE_LIMITS,
  type PreparedAttachment,
  preparePhotos,
  prepareVoice,
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

/** One voice memo per note (SPEC-notes "Limits"); `field` is the form field that added one. */
function assertVoiceCount(count: number, field: string): void {
  if (count > 1) {
    throw new AppError("BAD_REQUEST", "errors.notes.tooManyVoiceMemos", {
      [field]: "errors.notes.tooManyVoiceMemos",
    });
  }
}

/**
 * The recorder's duration goes with a memo and only with one: whole milliseconds, 1 ms to
 * 5 minutes. The contract coerces and checks it too; core doesn't rely on that.
 */
function assertVoiceDuration(voice: File | undefined, durationMs: number | undefined): void {
  const invalid = (key: "required" | "invalid" | "tooSmall" | "tooBig") =>
    new AppError("BAD_REQUEST", "errors.validation", { voiceDurationMs: `errors.field.${key}` });
  if (durationMs === undefined) {
    if (voice) throw invalid("required");
    return;
  }
  if (!voice || !Number.isInteger(durationMs)) throw invalid("invalid");
  if (durationMs < 1) throw invalid("tooSmall");
  if (durationMs > NOTE_VOICE_MAX_MS) throw invalid("tooBig");
}

/** The memo first: it's a cheap check, and a refused one shouldn't wait for photos to resize. */
async function prepareFiles(
  noteId: string,
  photos: File[],
  voice: { file: File | undefined; durationMs: number | undefined; field: string },
): Promise<PreparedAttachment[]> {
  const memo =
    voice.file && voice.durationMs !== undefined
      ? [await prepareVoice(noteId, voice.file, voice.durationMs, voice.field)]
      : [];
  return [...memo, ...(await preparePhotos(noteId, photos))];
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
  const note = await tx.note.findUnique({ where: { id }, include: noteInclude });
  // A replayed create whose note was deleted since: the request's result is gone.
  if (!note) throw notFound();
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
  const content = cleanContent(input.content, photos.length + (input.voice ? 1 : 0));
  assertPhotoCount(photos.length);
  assertVoiceDuration(input.voice, input.voiceDurationMs);
  // A replay returns the stored note, so it shouldn't process or upload anything.
  const replay = await db.idempotentRequest.findUnique({
    where: { key: input.idempotencyKey },
    select: { key: true },
  });
  const target = input.target ?? { kind: "order" };
  // Refuse a missing order or a target from another order before processing files, as
  // `updateNote` does; the transaction checks both again.
  if (!replay) {
    await orderStatus(db, input.orderId);
    await resolveTarget(db, input.orderId, target);
  }
  const noteId = uuidv7();

  return withUploads(
    storage,
    () =>
      replay
        ? Promise.resolve([])
        : prepareFiles(noteId, photos, {
            file: input.voice,
            durationMs: input.voiceDurationMs,
            field: "voice",
          }),
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
            const columns = await resolveTarget(tx, input.orderId, target);
            const note = await tx.note.create({
              data: {
                id: noteId,
                orderId: input.orderId,
                ...columns,
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
                ...columns,
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

/**
 * An internal, text-only note written inside the caller's transaction (SPEC-picking "Line
 * notes"), so it commits or rolls back with the caller's write. The caller handles idempotency
 * and tells open pages about the change; photos can be added afterwards with `updateNote`.
 */
export async function createTextNote(
  tx: DbTx,
  actor: Actor,
  input: { orderId: string; orderItemId?: string; content: string },
): Promise<{ id: string }> {
  assertCan(actor, "note.write");
  const content = cleanContent(input.content);
  const columns = await resolveTarget(
    tx,
    input.orderId,
    input.orderItemId ? { kind: "item", id: input.orderItemId } : { kind: "order" },
  );
  const note = await tx.note.create({
    data: {
      orderId: input.orderId,
      ...columns,
      authorId: actor.userId,
      content,
      visibility: "INTERNAL",
    },
  });
  await recordAudit(tx, actor, {
    entityType: "Note",
    entityId: note.id,
    action: "create",
    after: { orderId: note.orderId, ...columns, ...snapshot(note), attachmentIds: [] },
  });
  return { id: note.id };
}

type NoteWithAttachments = Prisma.NoteGetPayload<{ include: { attachments: true } }>;

/**
 * The note with its row held until the transaction ends. `shipping`'s `markNotePushed` takes the
 * same row, so an edit or delete that overlaps a push waits for it and then sees the note frozen,
 * instead of changing a note WooCommerce already has (defect #8).
 */
async function findNoteForWrite(tx: DbTx, id: string): Promise<NoteWithAttachments | null> {
  await tx.$queryRaw`SELECT id FROM notes WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.note.findUnique({ where: { id }, include: { attachments: true } });
}

/**
 * Checks an update against the note as it is: author, visibility, removals that belong to it, and
 * totals that still fit. Runs before uploading and again inside the transaction.
 */
function planUpdate(actor: Actor, existing: NoteWithAttachments, input: UpdateNoteInput) {
  assertMayEdit(actor, existing);
  assertVoiceDuration(input.addVoice, input.voiceDurationMs);
  const removeIds = new Set(input.removeAttachmentIds ?? []);
  const known = new Set(existing.attachments.map((a) => a.id));
  if ([...removeIds].some((id) => !known.has(id))) throw notFound();
  const kept = existing.attachments.filter((a) => !removeIds.has(a.id));
  const addPhotos = input.addPhotos?.length ?? 0;
  const addVoice = input.addVoice ? 1 : 0;
  assertPhotoCount(kept.filter((a) => a.kind === "IMAGE").length + addPhotos);
  assertVoiceCount(kept.filter((a) => a.kind === "VOICE").length + addVoice, "addVoice");
  const next = {
    content: cleanContent(input.content ?? existing.content, kept.length + addPhotos + addVoice),
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
  // Refuse before processing files: a forbidden or invalid edit uploads nothing.
  const before = await db.note.findUnique({
    where: { id: input.id },
    include: { attachments: true },
  });
  if (!before) throw notFound();
  planUpdate(actor, before, input);

  return withUploads(
    storage,
    () =>
      prepareFiles(input.id, input.addPhotos ?? [], {
        file: input.addVoice,
        durationMs: input.voiceDurationMs,
        field: "addVoice",
      }),
    (prepared) =>
      db.$transaction(async (tx) => {
        const existing = await findNoteForWrite(tx, input.id);
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

        await tx.noteAttachment.deleteMany({ where: { id: { in: removed.map((a) => a.id) } } });
        await enqueueFileDeletion(tx, removed);
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
    const existing = await findNoteForWrite(tx, id);
    if (!existing) throw notFound();
    assertMayEdit(actor, existing);
    await tx.note.delete({ where: { id } });
    await enqueueFileDeletion(tx, existing.attachments);
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
