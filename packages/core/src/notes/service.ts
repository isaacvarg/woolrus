import type {
  CreateNoteInput,
  Note as NoteDto,
  NoteVisibility,
  UpdateNoteInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Prisma } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan, can } from "../permissions";
import { notifyOrderChanged } from "../workflow/notify";
import { resolveTarget, targetInclude, targetOf } from "./targets";

const MAX_CONTENT = 4000;

const noteInclude = {
  author: { select: { name: true } },
  ...targetInclude,
} satisfies Prisma.NoteInclude;
type NoteRow = Prisma.NoteGetPayload<{ include: typeof noteInclude }>;

/** The contract trims and caps content already; core doesn't rely on it. */
function cleanContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
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
  actor: Actor,
  input: Omit<CreateNoteInput, "target"> & Partial<Pick<CreateNoteInput, "target">>,
): Promise<NoteDto> {
  assertCan(actor, "note.write");
  assertCanWriteVisibility(actor, input.visibility);
  const content = cleanContent(input.content);
  return db.$transaction(async (tx) => {
    // Only the id is stored for replays: the stored JSON would turn the dates into strings.
    const { id } = await withIdempotency(
      tx,
      input.idempotencyKey,
      "notes.create",
      actor,
      async () => {
        const status = await orderStatus(tx, input.orderId);
        const target = await resolveTarget(tx, input.orderId, input.target ?? { kind: "order" });
        const note = await tx.note.create({
          data: {
            orderId: input.orderId,
            ...target,
            authorId: actor.userId,
            content,
            visibility: input.visibility,
          },
        });
        await recordAudit(tx, actor, {
          entityType: "Note",
          entityId: note.id,
          action: "create",
          after: { orderId: note.orderId, ...target, ...snapshot(note) },
        });
        await notifyOrderChanged(tx, { id: input.orderId, status });
        return { id: note.id };
      },
    );
    return loadNote(tx, actor, id);
  });
}

export async function updateNote(db: Db, actor: Actor, input: UpdateNoteInput): Promise<NoteDto> {
  assertCan(actor, "note.write");
  return db.$transaction(async (tx) => {
    const existing = await tx.note.findUnique({ where: { id: input.id } });
    if (!existing) throw notFound();
    assertMayEdit(actor, existing);
    const next = {
      content: input.content === undefined ? existing.content : cleanContent(input.content),
      visibility: input.visibility ?? existing.visibility,
    };
    // Editing a customer note is writing to the customer too, not only switching to it.
    assertCanWriteVisibility(actor, next.visibility);
    if (next.content === existing.content && next.visibility === existing.visibility) {
      return loadNote(tx, actor, existing.id);
    }

    await tx.note.update({ where: { id: existing.id }, data: { ...next, editedAt: new Date() } });
    await recordAudit(tx, actor, {
      entityType: "Note",
      entityId: existing.id,
      action: "update",
      before: snapshot(existing),
      after: next,
    });
    await notifyOrderChanged(tx, {
      id: existing.orderId,
      status: await orderStatus(tx, existing.orderId),
    });
    return loadNote(tx, actor, existing.id);
  });
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
