import type { NoteTarget, NoteVisibility } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { AppError, notFound } from "../errors";
import { targetInclude, targetOf } from "./targets";

/**
 * The contract `shipping` uses to post notes to WooCommerce exactly once (SRS §7.1 defect #8).
 * Internal: `shipping` checks its own permission and owns the HTTP call and retries.
 */

export type NoteToPush = {
  id: string;
  visibility: NoteVisibility;
  content: string;
  /** Null once the author's account is gone. */
  authorName: string | null;
  /** The same target as the notes list (`targetOf`); `shipping` words it per kind. */
  target: NoteTarget;
  /** Text only goes to WooCommerce; attachments are mentioned as counts. */
  attachments: { photos: number; voice: number };
  createdAt: Date;
};

const pushInclude = {
  author: { select: { name: true } },
  ...targetInclude,
  attachments: { select: { kind: true } },
} satisfies Prisma.NoteInclude;

/** Notes of the order not yet in WooCommerce, oldest first. */
export async function notesToPush(tx: DbTx, orderId: string): Promise<NoteToPush[]> {
  const notes = await tx.note.findMany({
    where: { orderId, wooNoteId: null },
    include: pushInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return notes.map((note) => ({
    id: note.id,
    visibility: note.visibility,
    content: note.content,
    authorName: note.author?.name ?? null,
    target: targetOf(note),
    attachments: {
      photos: note.attachments.filter((a) => a.kind === "IMAGE").length,
      voice: note.attachments.filter((a) => a.kind === "VOICE").length,
    },
    createdAt: note.createdAt,
  }));
}

/** Records the WooCommerce note id; from then on the note is frozen. A second mark is refused. */
export async function markNotePushed(
  tx: DbTx,
  { noteId, wooNoteId }: { noteId: string; wooNoteId: number },
): Promise<void> {
  const { count } = await tx.note.updateMany({
    where: { id: noteId, wooNoteId: null },
    data: { wooNoteId, pushedToWooAt: new Date() },
  });
  if (count === 1) return;
  if (await tx.note.findUnique({ where: { id: noteId }, select: { id: true } })) {
    throw new AppError("CONFLICT", "errors.notes.alreadySent");
  }
  throw notFound();
}
