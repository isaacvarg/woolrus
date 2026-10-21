import type { CreateNoteInput } from "@woolrus/contracts";
import type { Db, WorkflowStatus } from "@woolrus/db";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { Actor } from "../permissions";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { createNote, deleteNote, listNotes, updateNote } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

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

    const note = await createNote(db, picker, input(order.id, { content: "  Box was crushed  " }));
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

    const edited = await updateNote(db, picker, { id: note.id, content: "Box was dented" });
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

    const first = await createNote(db, floor, input(order.id, { content: "first" }));
    const second = await createNote(db, desk, input(order.id, { content: "second" }));
    await createNote(db, desk, input(other.id, { content: "elsewhere" }));

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
      createNote(db, picker, input(order.id, { content: "   " })),
      "BAD_REQUEST",
      "errors.notes.empty",
    );
    await rejects(
      createNote(db, picker, input(order.id, { content: "x".repeat(4001) })),
      "BAD_REQUEST",
      "errors.validation",
    );
    const note = await createNote(db, picker, input(order.id, { content: "x".repeat(4000) }));
    await rejects(
      updateNote(db, picker, { id: note.id, content: " " }),
      "BAD_REQUEST",
      "errors.notes.empty",
    );
    expect(await db.note.count()).toBe(1);
  });

  it("returns the original note when a create is replayed", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    const request = input(order.id);
    const first = await createNote(db, picker, request);
    const replay = await createNote(db, picker, request);
    expect(replay).toEqual(first);
    expect(await db.note.count()).toBe(1);
  });

  it("works in every order status, needs no claim and leaves the order's version alone", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const qa = await createActor(db, ["QA"]);
    const statuses: WorkflowStatus[] = ["PENDING", "PACKING", "COMPLETED", "CANCELLED"];
    for (const status of statuses) {
      const { order } = await createOrder(db, { status, version: 4, claimedById: qa.userId });
      const note = await createNote(db, picker, input(order.id));
      await updateNote(db, picker, { id: note.id, content: "changed" });
      await deleteNote(db, picker, { id: note.id });
      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after).toMatchObject({ version: 4, claimedById: qa.userId });
    }
    expect(await db.orderStageEvent.count()).toBe(0);
  });

  it("refuses notes on an unknown order and edits of an unknown note", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const missing = "0199e6a0-0000-7000-8000-000000000001";
    await rejects(createNote(db, picker, input(missing)), "NOT_FOUND", "errors.notFound");
    await rejects(listNotes(db, picker, { orderId: missing }), "NOT_FOUND", "errors.notFound");
    await rejects(
      updateNote(db, picker, { id: missing, content: "x" }),
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
        await createNote(db, actor, input(order.id));
        expect((await listNotes(db, actor, { orderId: order.id })).length).toBeGreaterThan(0);
      }
      await rejects(listNotes(db, nobody, { orderId: order.id }), "FORBIDDEN", "errors.forbidden");
      await rejects(createNote(db, nobody, input(order.id)), "FORBIDDEN", "errors.forbidden");
    });

    it("lets only the author or an admin edit or delete a note (FR-NOTE-07)", async () => {
      const author = await createActor(db, ["PICKER"]);
      const otherPicker = await createActor(db, ["PICKER"]);
      const admin = await createActor(db, ["ADMIN"]);
      const { order } = await createOrder(db);
      const note = await createNote(db, author, input(order.id));

      await rejects(
        updateNote(db, otherPicker, { id: note.id, content: "mine now" }),
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

      const moderated = await updateNote(db, admin, { id: note.id, content: "redacted" });
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
          createNote(db, actor, input(order.id, { visibility: "CUSTOMER" })),
          "FORBIDDEN",
          "errors.forbidden",
        );
        const own = await createNote(db, actor, input(order.id));
        await rejects(
          updateNote(db, actor, { id: own.id, visibility: "CUSTOMER" }),
          "FORBIDDEN",
          "errors.forbidden",
        );
      }
      for (const role of ["ADMIN", "QA", "SHIPPER"] as const) {
        const actor = await createActor(db, [role]);
        const note = await createNote(db, actor, input(order.id, { visibility: "CUSTOMER" }));
        expect(note.visibility).toBe("CUSTOMER");
        const internal = await updateNote(db, actor, { id: note.id, visibility: "INTERNAL" });
        expect(internal.visibility).toBe("INTERNAL");
        expect(
          (await updateNote(db, actor, { id: note.id, visibility: "CUSTOMER" })).visibility,
        ).toBe("CUSTOMER");
      }
      expect(await db.note.count({ where: { visibility: "CUSTOMER" } })).toBe(3);
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
      const note = await createNote(db, picker, input(order.id));
      await updateNote(db, picker, { id: note.id, content: "changed" });
      await deleteNote(db, picker, { id: note.id });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const event = { id: order.id, status: "PACKING" };
      expect(received).toEqual([event, event, event]);
    });
  });
});
