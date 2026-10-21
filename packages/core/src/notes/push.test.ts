import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createMemoryStorage } from "../adapters/storage/memory";
import { markNotePushed, notesToPush } from "./push";
import { createNote, deleteNote, listNotes, updateNote } from "./service";

// Text-only notes upload nothing; the service still takes a storage.
const storage = createMemoryStorage();

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

let keySeq = 0;
const key = () => {
  keySeq += 1;
  return `push-key-${keySeq}`;
};

const rejects = (promise: Promise<unknown>, kind: string, messageKey: string) =>
  expect(promise).rejects.toMatchObject({ kind, messageKey });

describe("notes to push to WooCommerce", () => {
  it("lists unsent notes oldest first, with what shipping needs to format them", async () => {
    const author = await createActor(db, ["ADMIN"]);
    const { order, items, packages } = await createOrder(db, {
      lines: [{ name: "Lavender soap", quantity: 2 }],
      packages: [{ items: [{ line: 0, quantity: 2 }] }],
    });
    const line = items[0];
    const pkg = packages[0];
    if (!line || !pkg) throw new Error("factory");
    const issue = await db.qualityIssue.create({
      data: {
        orderId: order.id,
        type: "DAMAGED_ITEM",
        severity: "MINOR",
        description: "Dented lid",
        discoveredStage: "QA",
      },
    });
    const { order: other } = await createOrder(db);

    const first = await createNote(db, storage, author, {
      idempotencyKey: key(),
      orderId: order.id,
      content: "Gift wrap please",
      visibility: "CUSTOMER",
    });
    // Targets and attachments are written directly until their tickets land.
    const second = await db.note.create({
      data: {
        orderId: order.id,
        orderItemId: line.id,
        authorId: author.userId,
        content: "Scuffed",
      },
    });
    await db.noteAttachment.createMany({
      data: [
        {
          noteId: second.id,
          kind: "IMAGE",
          storageKey: "k1",
          contentType: "image/webp",
          fileName: "a.jpg",
          sizeBytes: 1,
        },
        {
          noteId: second.id,
          kind: "IMAGE",
          storageKey: "k2",
          contentType: "image/webp",
          fileName: "b.jpg",
          sizeBytes: 1,
        },
        {
          noteId: second.id,
          kind: "VOICE",
          storageKey: "k3",
          contentType: "audio/webm",
          fileName: "v.webm",
          sizeBytes: 1,
        },
      ],
    });
    const third = await db.note.create({
      data: { orderId: order.id, packageId: pkg.id, authorId: null, content: "Heavy" },
    });
    const fourth = await db.note.create({
      data: {
        orderId: order.id,
        qualityIssueId: issue.id,
        authorId: author.userId,
        content: "Fixed",
      },
    });
    await db.note.create({ data: { orderId: other.id, content: "Other order" } });

    const toPush = await db.$transaction((tx) => notesToPush(tx, order.id));
    expect(toPush).toEqual([
      {
        id: first.id,
        visibility: "CUSTOMER",
        content: "Gift wrap please",
        authorName: "Test User",
        target: { kind: "order", id: order.id, label: order.number },
        attachments: { photos: 0, voice: 0 },
        createdAt: first.createdAt,
      },
      {
        id: second.id,
        visibility: "INTERNAL",
        content: "Scuffed",
        authorName: "Test User",
        target: { kind: "item", id: line.id, label: "Lavender soap ×2" },
        attachments: { photos: 2, voice: 1 },
        createdAt: second.createdAt,
      },
      {
        id: third.id,
        visibility: "INTERNAL",
        content: "Heavy",
        authorName: null,
        target: { kind: "package", id: pkg.id, label: String(pkg.number) },
        attachments: { photos: 0, voice: 0 },
        createdAt: third.createdAt,
      },
      {
        id: fourth.id,
        visibility: "INTERNAL",
        content: "Fixed",
        authorName: "Test User",
        target: { kind: "issue", id: issue.id, label: "Dented lid" },
        attachments: { photos: 0, voice: 0 },
        createdAt: fourth.createdAt,
      },
    ]);
  });

  it("marks notes pushed so a retry posts nothing twice (defect #8)", async () => {
    const author = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    for (const content of ["one", "two"]) {
      await createNote(db, storage, author, {
        idempotencyKey: key(),
        orderId: order.id,
        content,
        visibility: "INTERNAL",
      });
    }

    const [one, two] = await db.$transaction((tx) => notesToPush(tx, order.id));
    if (!one || !two) throw new Error("expected two notes");
    await db.$transaction((tx) => markNotePushed(tx, { noteId: one.id, wooNoteId: 501 }));
    expect((await db.$transaction((tx) => notesToPush(tx, order.id))).map((n) => n.id)).toEqual([
      two.id,
    ]);
    await db.$transaction((tx) => markNotePushed(tx, { noteId: two.id, wooNoteId: 502 }));
    expect(await db.$transaction((tx) => notesToPush(tx, order.id))).toEqual([]);

    const stored = await db.note.findUniqueOrThrow({ where: { id: one.id } });
    expect(stored.wooNoteId).toBe(501);
    expect(stored.pushedToWooAt).toBeInstanceOf(Date);
    const listed = await listNotes(db, author, { orderId: order.id });
    expect(listed.every((n) => n.pushedToWooAt instanceof Date)).toBe(true);
  });

  it("refuses to mark a note pushed twice", async () => {
    const author = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    const note = await createNote(db, storage, author, {
      idempotencyKey: key(),
      orderId: order.id,
      content: "once",
      visibility: "INTERNAL",
    });
    await db.$transaction((tx) => markNotePushed(tx, { noteId: note.id, wooNoteId: 7 }));
    await rejects(
      db.$transaction((tx) => markNotePushed(tx, { noteId: note.id, wooNoteId: 8 })),
      "CONFLICT",
      "errors.notes.alreadySent",
    );
    expect((await db.note.findUniqueOrThrow({ where: { id: note.id } })).wooNoteId).toBe(7);
  });

  it("freezes a pushed note for everyone, including Admin", async () => {
    const author = await createActor(db, ["PICKER"]);
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await createOrder(db);
    const note = await createNote(db, storage, author, {
      idempotencyKey: key(),
      orderId: order.id,
      content: "Sent",
      visibility: "INTERNAL",
    });
    await db.$transaction((tx) => markNotePushed(tx, { noteId: note.id, wooNoteId: 9 }));

    for (const actor of [author, admin]) {
      await rejects(
        updateNote(db, storage, actor, { id: note.id, content: "changed" }),
        "CONFLICT",
        "errors.notes.alreadySent",
      );
      await rejects(deleteNote(db, actor, { id: note.id }), "CONFLICT", "errors.notes.alreadySent");
      const [listed] = await listNotes(db, actor, { orderId: order.id });
      expect(listed).toMatchObject({ content: "Sent", canEdit: false });
    }
  });
});
