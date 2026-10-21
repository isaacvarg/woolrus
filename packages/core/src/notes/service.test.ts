import type { CreateNoteInput } from "@woolrus/contracts";
import type { Db, WorkflowStatus } from "@woolrus/db";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createMemoryStorage, type MemoryStorage } from "../adapters/storage/memory";
import type { Actor } from "../permissions";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { NOTE_FILE_LIMITS } from "./media";
import { createNote, deleteNote, getAttachment, listNotes, updateNote } from "./service";
import { fileOf, solidImage } from "./test-files";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));
let storage: MemoryStorage;
beforeEach(() => {
  storage = createMemoryStorage();
});

let keySeq = 0;
function input(
  orderId: string,
  fields: Partial<Omit<CreateNoteInput, "orderId">> = {},
): CreateNoteInput {
  keySeq += 1;
  return {
    idempotencyKey: `note-key-${keySeq}`,
    orderId,
    content: "Box was crushed",
    visibility: "INTERNAL",
    target: { kind: "order" },
    ...fields,
  };
}

const rejects = (promise: Promise<unknown>, kind: string, messageKey: string) =>
  expect(promise).rejects.toMatchObject({ kind, messageKey });

describe("notes service", () => {
  it("creates, lists, edits and deletes a note, each audited", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    const note = await createNote(
      db,
      storage,
      picker,
      input(order.id, { content: "  Box was crushed  " }),
    );
    expect(note).toMatchObject({
      orderId: order.id,
      content: "Box was crushed",
      visibility: "INTERNAL",
      authorId: picker.userId,
      authorName: "Test User",
      stationName: null,
      editedAt: null,
      pushedToWooAt: null,
      canEdit: true,
    });

    const edited = await updateNote(db, storage, picker, {
      id: note.id,
      content: "Box was dented",
    });
    expect(edited.content).toBe("Box was dented");
    expect(edited.editedAt).toBeInstanceOf(Date);
    expect(await listNotes(db, picker, { orderId: order.id })).toEqual([edited]);

    expect(await deleteNote(db, picker, { id: note.id })).toEqual({ id: note.id });
    expect(await listNotes(db, picker, { orderId: order.id })).toEqual([]);

    const audit = await db.auditEvent.findMany({
      where: { entityType: "Note" },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => [e.entityId, e.action, e.actorId])).toEqual([
      [note.id, "create", picker.userId],
      [note.id, "update", picker.userId],
      [note.id, "delete", picker.userId],
    ]);
    expect(audit[1]?.before).toMatchObject({ content: "Box was crushed", visibility: "INTERNAL" });
    expect(audit[1]?.after).toMatchObject({ content: "Box was dented", visibility: "INTERNAL" });
    // Deleting is a hard delete: the audit row keeps the text.
    expect(audit[2]?.before).toMatchObject({ content: "Box was dented", orderId: order.id });
  });

  it("lists notes oldest first, with the station from the create audit", async () => {
    const station = await db.station.create({ data: { name: "Tablet 3", tokenHash: "hash-3" } });
    const desk = await createActor(db, ["PACKER"]);
    const floor: Actor = { ...(await createActor(db, ["PICKER"])), stationId: station.id };
    const { order } = await createOrder(db);
    const { order: other } = await createOrder(db);

    const first = await createNote(db, storage, floor, input(order.id, { content: "first" }));
    const second = await createNote(db, storage, desk, input(order.id, { content: "second" }));
    await createNote(db, storage, desk, input(other.id, { content: "elsewhere" }));

    const list = await listNotes(db, desk, { orderId: order.id });
    expect(list.map((n) => [n.id, n.stationName, n.canEdit])).toEqual([
      [first.id, "Tablet 3", false],
      [second.id, null, true],
    ]);
    // On a station the note belongs to the person who unlocked it, not the tablet.
    expect(first.authorId).toBe(floor.userId);
  });

  it("refuses an empty note and one over 4000 characters", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    await rejects(
      createNote(db, storage, picker, input(order.id, { content: "   " })),
      "BAD_REQUEST",
      "errors.notes.empty",
    );
    await rejects(
      createNote(db, storage, picker, input(order.id, { content: "x".repeat(4001) })),
      "BAD_REQUEST",
      "errors.validation",
    );
    const note = await createNote(
      db,
      storage,
      picker,
      input(order.id, { content: "x".repeat(4000) }),
    );
    await rejects(
      updateNote(db, storage, picker, { id: note.id, content: " " }),
      "BAD_REQUEST",
      "errors.notes.empty",
    );
    expect(await db.note.count()).toBe(1);
  });

  it("returns the original note when a create is replayed", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    const request = input(order.id);
    const first = await createNote(db, storage, picker, request);
    const replay = await createNote(db, storage, picker, request);
    expect(replay).toEqual(first);
    expect(await db.note.count()).toBe(1);
  });

  it("works in every order status, needs no claim and leaves the order's version alone", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const qa = await createActor(db, ["QA"]);
    const statuses: WorkflowStatus[] = ["PENDING", "PACKING", "COMPLETED", "CANCELLED"];
    for (const status of statuses) {
      const { order } = await createOrder(db, { status, version: 4, claimedById: qa.userId });
      const note = await createNote(db, storage, picker, input(order.id));
      await updateNote(db, storage, picker, { id: note.id, content: "changed" });
      await deleteNote(db, picker, { id: note.id });
      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after).toMatchObject({ version: 4, claimedById: qa.userId });
    }
    expect(await db.orderStageEvent.count()).toBe(0);
  });

  it("refuses notes on an unknown order and edits of an unknown note", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const missing = "0199e6a0-0000-7000-8000-000000000001";
    await rejects(createNote(db, storage, picker, input(missing)), "NOT_FOUND", "errors.notFound");
    await rejects(listNotes(db, picker, { orderId: missing }), "NOT_FOUND", "errors.notFound");
    await rejects(
      updateNote(db, storage, picker, { id: missing, content: "x" }),
      "NOT_FOUND",
      "errors.notFound",
    );
    await rejects(deleteNote(db, picker, { id: missing }), "NOT_FOUND", "errors.notFound");
  });

  describe("permissions", () => {
    it("lets everyone read and write, and nobody without a role", async () => {
      const nobody = await createActor(db, []);
      const { order } = await createOrder(db);
      for (const role of ["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"] as const) {
        const actor = await createActor(db, [role]);
        await createNote(db, storage, actor, input(order.id));
        expect((await listNotes(db, actor, { orderId: order.id })).length).toBeGreaterThan(0);
      }
      await rejects(listNotes(db, nobody, { orderId: order.id }), "FORBIDDEN", "errors.forbidden");
      await rejects(
        createNote(db, storage, nobody, input(order.id)),
        "FORBIDDEN",
        "errors.forbidden",
      );
    });

    it("lets only the author or an admin edit or delete a note (FR-NOTE-07)", async () => {
      const author = await createActor(db, ["PICKER"]);
      const otherPicker = await createActor(db, ["PICKER"]);
      const admin = await createActor(db, ["ADMIN"]);
      const { order } = await createOrder(db);
      const note = await createNote(db, storage, author, input(order.id));

      await rejects(
        updateNote(db, storage, otherPicker, { id: note.id, content: "mine now" }),
        "FORBIDDEN",
        "errors.notes.notAuthor",
      );
      await rejects(
        deleteNote(db, otherPicker, { id: note.id }),
        "FORBIDDEN",
        "errors.notes.notAuthor",
      );
      expect((await listNotes(db, otherPicker, { orderId: order.id }))[0]?.canEdit).toBe(false);
      expect((await listNotes(db, admin, { orderId: order.id }))[0]?.canEdit).toBe(true);

      const moderated = await updateNote(db, storage, admin, { id: note.id, content: "redacted" });
      expect(moderated).toMatchObject({
        content: "redacted",
        authorId: author.userId,
        canEdit: true,
      });
      await deleteNote(db, admin, { id: note.id });
      expect(await db.note.count()).toBe(0);
    });

    it("lets only Admin, QA and Shipper write customer-visible notes (FR-NOTE-08)", async () => {
      const { order } = await createOrder(db);
      for (const role of ["PICKER", "PACKER"] as const) {
        const actor = await createActor(db, [role]);
        await rejects(
          createNote(db, storage, actor, input(order.id, { visibility: "CUSTOMER" })),
          "FORBIDDEN",
          "errors.forbidden",
        );
        const own = await createNote(db, storage, actor, input(order.id));
        await rejects(
          updateNote(db, storage, actor, { id: own.id, visibility: "CUSTOMER" }),
          "FORBIDDEN",
          "errors.forbidden",
        );
      }
      for (const role of ["ADMIN", "QA", "SHIPPER"] as const) {
        const actor = await createActor(db, [role]);
        const note = await createNote(
          db,
          storage,
          actor,
          input(order.id, { visibility: "CUSTOMER" }),
        );
        expect(note.visibility).toBe("CUSTOMER");
        const internal = await updateNote(db, storage, actor, {
          id: note.id,
          visibility: "INTERNAL",
        });
        expect(internal.visibility).toBe("INTERNAL");
        expect(
          (await updateNote(db, storage, actor, { id: note.id, visibility: "CUSTOMER" }))
            .visibility,
        ).toBe("CUSTOMER");
      }
      expect(await db.note.count({ where: { visibility: "CUSTOMER" } })).toBe(3);
    });
  });

  describe("photos", () => {
    const photo = async (name = "photo.jpg") => fileOf(await solidImage(64, 48, "jpeg"), name);
    const pdf = () => fileOf(new TextEncoder().encode("%PDF-1.7"), "scan.jpg", "image/jpeg");
    const nothingWritten = async () => {
      expect(storage.keys()).toEqual([]);
      expect(await db.note.count()).toBe(0);
      expect(await db.noteAttachment.count()).toBe(0);
    };

    it("stores photos and their thumbnails under the note's keys and lists them", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db);
      const note = await createNote(
        db,
        storage,
        picker,
        input(order.id, { content: "", photos: [await photo("a.jpg"), await photo("b.jpg")] }),
      );

      expect(note.content).toBe("");
      expect(note.attachments).toHaveLength(2);
      const [a] = note.attachments;
      expect(a).toMatchObject({
        kind: "IMAGE",
        contentType: "image/webp",
        fileName: "a.jpg",
        width: 64,
        height: 48,
        durationMs: null,
        url: `/api/attachments/${a?.id}`,
        thumbUrl: `/api/attachments/${a?.id}/thumb`,
      });
      expect(storage.keys()).toEqual(
        note.attachments
          .flatMap((x) => [`notes/${note.id}/${x.id}-thumb.webp`, `notes/${note.id}/${x.id}.webp`])
          .sort(),
      );
      const stored = await storage.get(`notes/${note.id}/${a?.id}.webp`);
      expect(stored.size).toBe(a?.sizeBytes);
      expect((await listNotes(db, picker, { orderId: order.id }))[0]?.attachments).toEqual(
        note.attachments,
      );
    });

    it("refuses a bad file, too many photos or an empty note and writes nothing", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db);
      const big = new Uint8Array(NOTE_FILE_LIMITS.fileBytes + 1024 * 1024);
      big.set([0xff, 0xd8, 0xff]);
      const svg = fileOf(new TextEncoder().encode("<svg/>"), "x.svg", "image/svg+xml");
      const cases: [CreateNoteInput["photos"], string][] = [
        [[await photo(), fileOf(big, "big.jpg")], "errors.notes.fileTooLarge"],
        [[await photo(), pdf()], "errors.notes.fileType"],
        [[svg], "errors.notes.fileType"],
        [
          await Promise.all(Array.from({ length: 11 }, () => photo())),
          "errors.notes.tooManyPhotos",
        ],
      ];
      for (const [photos, messageKey] of cases) {
        await rejects(
          createNote(db, storage, picker, input(order.id, { photos })),
          "BAD_REQUEST",
          messageKey,
        );
      }
      await rejects(
        createNote(db, storage, picker, input(order.id, { content: " ", photos: [] })),
        "BAD_REQUEST",
        "errors.notes.empty",
      );
      await nothingWritten();
    });

    it("deletes the uploads when the note transaction fails", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const missing = "0199e6a0-0000-7000-8000-000000000002";
      await rejects(
        createNote(db, storage, picker, input(missing, { photos: [await photo()] })),
        "NOT_FOUND",
        "errors.notFound",
      );
      await nothingWritten();
    });

    it("uploads nothing on an idempotent replay", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db);
      const request = input(order.id, { photos: [await photo()] });
      const first = await createNote(db, storage, picker, request);
      const keys = storage.keys();
      let puts = 0;
      const counting = {
        ...storage,
        put: (...args: Parameters<MemoryStorage["put"]>) => {
          puts += 1;
          return storage.put(...args);
        },
      };
      expect(await createNote(db, counting, picker, request)).toEqual(first);
      expect(puts).toBe(0);
      expect(storage.keys()).toEqual(keys);
    });

    it("adds and removes photos on edit, within 10 in total", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const other = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db);
      const note = await createNote(
        db,
        storage,
        picker,
        input(order.id, { photos: await Promise.all(Array.from({ length: 9 }, () => photo())) }),
      );
      const keysBefore = storage.keys();

      // Refused edits upload nothing.
      await rejects(
        updateNote(db, storage, picker, { id: note.id, addPhotos: [await photo(), await photo()] }),
        "BAD_REQUEST",
        "errors.notes.tooManyPhotos",
      );
      await rejects(
        updateNote(db, storage, other, { id: note.id, addPhotos: [await photo()] }),
        "FORBIDDEN",
        "errors.notes.notAuthor",
      );
      await rejects(
        updateNote(db, storage, picker, { id: note.id, addPhotos: [pdf()] }),
        "BAD_REQUEST",
        "errors.notes.fileType",
      );
      await rejects(
        updateNote(db, storage, picker, {
          id: note.id,
          removeAttachmentIds: ["0199e6a0-0000-7000-8000-000000000003"],
        }),
        "NOT_FOUND",
        "errors.notFound",
      );
      expect(storage.keys()).toEqual(keysBefore);

      const [first, second] = note.attachments;
      const edited = await updateNote(db, storage, picker, {
        id: note.id,
        removeAttachmentIds: [first?.id ?? "", second?.id ?? ""],
        addPhotos: [await photo("new-1.jpg"), await photo("new-2.jpg"), await photo("new-3.jpg")],
      });
      expect(edited.attachments).toHaveLength(10);
      expect(edited.attachments.map((a) => a.id)).not.toContain(first?.id);
      expect(edited.attachments.slice(-3).map((a) => a.fileName)).toEqual([
        "new-1.jpg",
        "new-2.jpg",
        "new-3.jpg",
      ]);
      expect(edited.editedAt).toBeInstanceOf(Date);

      // A note with no text can't lose its last file.
      const bare = await createNote(
        db,
        storage,
        picker,
        input(order.id, { content: "", photos: [await photo()] }),
      );
      await rejects(
        updateNote(db, storage, picker, {
          id: bare.id,
          removeAttachmentIds: [bare.attachments[0]?.id ?? ""],
        }),
        "BAD_REQUEST",
        "errors.notes.empty",
      );
    });

    it("resolves an attachment for anyone who can read orders", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const nobody = await createActor(db, []);
      const { order } = await createOrder(db);
      const note = await createNote(
        db,
        storage,
        picker,
        input(order.id, { photos: [await photo()] }),
      );
      const id = note.attachments[0]?.id ?? "";

      expect(await getAttachment(db, picker, { id, variant: "full" })).toEqual({
        key: `notes/${note.id}/${id}.webp`,
        contentType: "image/webp",
        fileName: "photo.jpg",
      });
      expect(await getAttachment(db, picker, { id, variant: "thumb" })).toMatchObject({
        key: `notes/${note.id}/${id}-thumb.webp`,
      });
      await rejects(
        getAttachment(db, nobody, { id, variant: "full" }),
        "FORBIDDEN",
        "errors.forbidden",
      );
      await rejects(
        getAttachment(db, picker, { id: "0199e6a0-0000-7000-8000-000000000004", variant: "full" }),
        "NOT_FOUND",
        "errors.notFound",
      );
    });
  });

  describe("notifications", () => {
    let listener: pg.Client;
    let received: unknown[];
    beforeEach(async () => {
      received = [];
      listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await listener.connect();
      listener.on("notification", (msg) => received.push(JSON.parse(msg.payload ?? "null")));
      await listener.query(`LISTEN ${ORDER_CHANGED_CHANNEL}`);
    });
    afterEach(() => listener.end());

    it("sends order_changed on create, edit and delete", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db, { status: "PACKING" });
      const note = await createNote(db, storage, picker, input(order.id));
      await updateNote(db, storage, picker, { id: note.id, content: "changed" });
      await deleteNote(db, picker, { id: note.id });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const event = { id: order.id, status: "PACKING" };
      expect(received).toEqual([event, event, event]);
    });
  });
});
