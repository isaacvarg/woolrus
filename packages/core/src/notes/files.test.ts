import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createMemoryStorage, type MemoryStorage } from "../adapters/storage/memory";
import { StorageError } from "../adapters/storage/storage";
import { queues } from "../jobs";
import { enqueueFileDeletion, runStorageDeleteJob, sweepOrphanFiles } from "./files";
import { createNote, deleteNote, updateNote } from "./service";
import { fileOf, solidImage } from "./test-files";

const db: Db = testDb();
afterAll(() => db.$disconnect());
let storage: MemoryStorage;
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.storageDelete}`;
  storage = createMemoryStorage();
});

async function deleteJobs() {
  return db.$queryRaw<{ keys: string[]; retry_limit: number; retry_backoff: boolean }[]>`
    SELECT data->'keys' AS keys, retry_limit, retry_backoff FROM pgboss.job
    WHERE name = ${queues.storageDelete} ORDER BY created_on`;
}

let keySeq = 0;
async function noteWithPhotos(count: number) {
  const picker = await createActor(db, ["PICKER"]);
  const { order } = await createOrder(db);
  const photos = await Promise.all(
    Array.from({ length: count }, async (_, i) =>
      fileOf(await solidImage(40, 30, "png"), `p${i}.png`, "image/png"),
    ),
  );
  keySeq += 1;
  const note = await createNote(db, storage, picker, {
    idempotencyKey: `files-key-${keySeq}`,
    orderId: order.id,
    content: "Dent",
    visibility: "INTERNAL",
    target: { kind: "order" },
    photos,
  });
  const rows = await db.noteAttachment.findMany({ where: { noteId: note.id } });
  return { picker, note, rows };
}

const keysOf = (rows: { storageKey: string; thumbnailKey: string | null }[]) =>
  rows.flatMap((r) => [r.storageKey, r.thumbnailKey ?? []].flat()).sort();

describe("deleting stored files", () => {
  it("deleteNote enqueues one storage.delete with every file and thumbnail, retried with backoff", async () => {
    const { picker, note, rows } = await noteWithPhotos(2);
    expect(storage.keys()).toHaveLength(4);

    await deleteNote(db, picker, { id: note.id });

    const jobs = await deleteJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.keys.sort()).toEqual(keysOf(rows));
    expect(jobs[0]).toMatchObject({ retry_backoff: true });
    expect(jobs[0]?.retry_limit).toBeGreaterThan(0);
  });

  it("deleting a note without files enqueues nothing", async () => {
    const { picker, note } = await noteWithPhotos(0);
    await deleteNote(db, picker, { id: note.id });
    expect(await deleteJobs()).toEqual([]);
  });

  it("a refused delete enqueues nothing", async () => {
    const { note } = await noteWithPhotos(1);
    const other = await createActor(db, ["PICKER"]);
    await expect(deleteNote(db, other, { id: note.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await deleteJobs()).toEqual([]);
  });

  it("removing an attachment in updateNote enqueues its keys only", async () => {
    const { picker, note, rows } = await noteWithPhotos(2);
    const [gone] = rows;
    if (!gone) throw new Error("no attachment");

    await updateNote(db, storage, picker, { id: note.id, removeAttachmentIds: [gone.id] });

    const jobs = await deleteJobs();
    expect(jobs.map((j) => j.keys.sort())).toEqual([keysOf([gone])]);
  });

  it("an edit that removes nothing enqueues nothing", async () => {
    const { picker, note } = await noteWithPhotos(1);
    await updateNote(db, storage, picker, { id: note.id, content: "Dented" });
    expect(await deleteJobs()).toEqual([]);
  });

  it("is enqueued on the caller's transaction: gone on rollback", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await enqueueFileDeletion(tx, [{ storageKey: "notes/a/b.webp", thumbnailKey: null }]);
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(await deleteJobs()).toEqual([]);
  });

  it("the job deletes the keys; missing ones count as done", async () => {
    await storage.put("notes/n/a.webp", new Uint8Array([1]), "image/webp");
    await storage.put("notes/n/keep.webp", new Uint8Array([1]), "image/webp");
    expect(
      await runStorageDeleteJob(storage, { keys: ["notes/n/a.webp", "notes/n/missing.webp"] }),
    ).toEqual({ deleted: 2 });
    expect(storage.keys()).toEqual(["notes/n/keep.webp"]);
  });

  it("the job throws a storage failure so pg-boss retries it", async () => {
    const failing = { ...storage, delete: () => Promise.reject(new StorageError("unavailable")) };
    await expect(runStorageDeleteJob(failing, { keys: ["notes/x"] })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("orphan sweep", () => {
  it("deletes unreferenced notes/ objects older than 24 h, keeps referenced and new ones", async () => {
    let now = new Date("2026-10-01T00:00:00Z");
    storage = createMemoryStorage({ now: () => now });
    const { rows } = await noteWithPhotos(1);
    await storage.put("notes/gone/orphan.webp", new Uint8Array([1]), "image/webp");
    await storage.put("other/old.bin", new Uint8Array([1]), "application/octet-stream");

    now = new Date("2026-10-01T23:00:00Z");
    await storage.put("notes/new/orphan.webp", new Uint8Array([1]), "image/webp");

    now = new Date("2026-10-02T01:00:00Z");
    const result = await sweepOrphanFiles(db, storage, { now: now });

    expect(result).toEqual({ scanned: 3, deleted: 1 });
    expect(storage.keys()).toEqual(
      [...keysOf(rows), "notes/new/orphan.webp", "other/old.bin"].sort(),
    );
  });

  it("collects files left behind when a cascade deletes the note", async () => {
    let now = new Date("2026-10-01T00:00:00Z");
    storage = createMemoryStorage({ now: () => now });
    const { note } = await noteWithPhotos(1);
    await db.note.delete({ where: { id: note.id } });

    now = new Date("2026-10-03T00:00:00Z");
    expect(await sweepOrphanFiles(db, storage, { now })).toEqual({ scanned: 2, deleted: 2 });
    expect(storage.keys()).toEqual([]);
  });
});
