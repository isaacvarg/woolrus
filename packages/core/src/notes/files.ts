import type { Db, DbTx } from "@woolrus/db";
import type { ObjectStorage } from "../adapters/storage/storage";
import { enqueue } from "../enqueue";
import { type JobPayloads, queues } from "../jobs";

// Stored files never outlive their note (SPEC-notes "Deleting files", FR-NOTE-06). Rows go in the
// note's transaction; the files go in a job enqueued on that same transaction, so a rollback keeps
// both. The daily sweep catches whatever that misses, including cascades from other modules.

/** Where every note file lives, and so where the sweep looks. */
export const NOTE_FILES_PREFIX = "notes/";
/** A file this young may belong to an upload whose note transaction hasn't committed yet. */
const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 500;

type StoredFiles = { storageKey: string; thumbnailKey: string | null };

const keysOf = (attachments: StoredFiles[]) =>
  attachments.flatMap((a) => (a.thumbnailKey ? [a.storageKey, a.thumbnailKey] : [a.storageKey]));

/** One `storage.delete` job for the attachments' files and thumbnails; none if there are none. */
export async function enqueueFileDeletion(tx: DbTx, attachments: StoredFiles[]): Promise<void> {
  const keys = keysOf(attachments);
  if (keys.length > 0) await enqueue(tx, queues.storageDelete, { keys });
}

/** Throws on a storage failure, so pg-boss retries with the queue's backoff. */
export async function runStorageDeleteJob(
  storage: ObjectStorage,
  { keys }: JobPayloads[typeof queues.storageDelete],
): Promise<{ deleted: number }> {
  await storage.delete(keys);
  return { deleted: keys.length };
}

async function deleteUnreferenced(db: Db, storage: ObjectStorage, keys: string[]) {
  const referenced = await db.noteAttachment.findMany({
    where: { OR: [{ storageKey: { in: keys } }, { thumbnailKey: { in: keys } }] },
    select: { storageKey: true, thumbnailKey: true },
  });
  const inUse = new Set(keysOf(referenced));
  const orphans = keys.filter((key) => !inUse.has(key));
  if (orphans.length > 0) await storage.delete(orphans);
  return orphans.length;
}

/**
 * Deletes `notes/` files older than 24 hours that no `NoteAttachment` points to. Changes no
 * business state, so it audits nothing; the worker logs the counts.
 */
export async function sweepOrphanFiles(
  db: Db,
  storage: ObjectStorage,
  { now = new Date() }: { now?: Date } = {},
): Promise<{ scanned: number; deleted: number }> {
  const olderThan = new Date(now.getTime() - SWEEP_MIN_AGE_MS);
  let scanned = 0;
  let deleted = 0;
  let batch: string[] = [];
  for await (const { key } of storage.list(NOTE_FILES_PREFIX, olderThan)) {
    scanned += 1;
    batch.push(key);
    if (batch.length === SWEEP_BATCH) {
      deleted += await deleteUnreferenced(db, storage, batch);
      batch = [];
    }
  }
  if (batch.length > 0) deleted += await deleteUnreferenced(db, storage, batch);
  return { scanned, deleted };
}
