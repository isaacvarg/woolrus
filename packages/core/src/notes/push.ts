import type { NoteVisibility } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { AppError, notFound } from "../errors";

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
  /** `label` is plain data (line name × quantity, `#<package number>`, issue description); `shipping` adds the prefix. */
  target:
    | { kind: "order"; id: null; label: null }
    | { kind: "item" | "package" | "issue"; id: string; label: string };
  /** Text only goes to WooCommerce; attachments are mentioned as counts. */
  attachments: { photos: number; voice: number };
  createdAt: Date;
};

const pushInclude = {
  author: { select: { name: true } },
  orderItem: { select: { id: true, name: true, quantity: true } },
  package: { select: { id: true, number: true } },
  qualityIssue: { select: { id: true, description: true } },
  attachments: { select: { kind: true } },
} satisfies Prisma.NoteInclude;
type PushRow = Prisma.NoteGetPayload<{ include: typeof pushInclude }>;

function pushTarget(note: PushRow): NoteToPush["target"] {
  if (note.orderItem) {
    const { id, name, quantity } = note.orderItem;
    return { kind: "item", id, label: `${name} ×${quantity}` };
  }
  if (note.package) {
    return { kind: "package", id: note.package.id, label: `#${note.package.number}` };
  }
  if (note.qualityIssue) {
    return { kind: "issue", id: note.qualityIssue.id, label: note.qualityIssue.description };
  }
  return { kind: "order", id: null, label: null };
}

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
    target: pushTarget(note),
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
