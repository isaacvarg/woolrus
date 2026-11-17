import type { Db } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fullActivity } from "../../test/activity";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createMemoryStorage } from "../adapters/storage/memory";
import { reportIssue, resolveIssue, setResponsible, updateIssue } from "../exceptions/issues";
import { resolveVoids, undoVoid, voidItem } from "../exceptions/voids";
import { createNote, deleteNote, updateNote } from "../notes/service";
import { actionMessageKey, actionRegistry } from "./actions";

// SPEC-order-activity (#203): voids and issues under Problems, notes under Notes, each worded,
// and note entries without the note's text.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("Problems and Notes wording", () => {
  const ofCategory = (category: string) =>
    Object.entries(actionRegistry)
      .filter(([, spec]) => spec.category === category)
      .map(([action]) => action);

  it.each(["en", "es"] as const)("words every Problems and Notes action in %s", (locale) => {
    const action = messages[locale].activity.action as Record<string, string | undefined>;
    const missing = [...ofCategory("problems"), ...ofCategory("notes")].filter(
      (key) => !action[actionMessageKey(key).slice("activity.action.".length)],
    );
    expect(missing).toEqual([]);
  });
});

describe("problems and notes in the order's activity", () => {
  it("shows a void, an issue and a note, with their order, and no note text", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order, items } = await createOrder(db, {
      status: "PACKING",
      lines: [{ quantity: 3, name: "Blue jar" }],
    });
    const line = items[0]?.id as string;
    const storage = createMemoryStorage();

    const voided = await voidItem(
      db,
      admin,
      { orderId: order.id, orderItemId: line, quantity: 2, reason: "Out of stock" },
      { now: minutesAgo(9) },
    );
    await undoVoid(db, admin, { voidId: voided.void.id }, { now: minutesAgo(8) });
    const again = await voidItem(
      db,
      admin,
      { orderId: order.id, orderItemId: line, quantity: 1, reason: "Out of stock" },
      { now: minutesAgo(7) },
    );
    await resolveVoids(
      db,
      admin,
      { voidIds: [again.void.id], resolution: "REFUNDED", notes: "Refunded in Woo" },
      { now: minutesAgo(6) },
    );

    const issue = await reportIssue(
      db,
      admin,
      {
        orderId: order.id,
        orderItemId: line,
        type: "DAMAGED_ITEM",
        severity: "MAJOR",
        description: "Cracked lid",
      },
      { now: minutesAgo(5) },
    );
    await updateIssue(db, admin, { issueId: issue.id, severity: "MINOR" }, { now: minutesAgo(4) });
    await setResponsible(
      db,
      admin,
      { issueId: issue.id, userId: admin.userId },
      { now: minutesAgo(4) },
    );
    await resolveIssue(
      db,
      admin,
      { issueId: issue.id, outcome: "RESOLVED", notes: "Replaced" },
      { now: minutesAgo(3) },
    );

    const note = await createNote(db, storage, admin, {
      idempotencyKey: "note-1",
      orderId: order.id,
      content: "Secret wording",
      visibility: "INTERNAL",
      target: { kind: "order" },
    });
    await updateNote(db, storage, admin, { id: note.id, content: "Edited secret" });
    const gone = await createNote(db, storage, admin, {
      idempotencyKey: "note-2",
      orderId: order.id,
      content: "Short-lived",
      visibility: "INTERNAL",
      target: { kind: "order" },
    });
    await deleteNote(db, admin, { id: gone.id });

    // Every row is found by its order (#197).
    const rows = await db.auditEvent.findMany({
      where: { entityType: { in: ["ItemVoid", "QualityIssue", "Note"] } },
      select: { orderId: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orderId === order.id)).toBe(true);

    const { entries } = await fullActivity(db, admin, { id: order.id });
    const of = (action: string, entityType?: string) =>
      entries.filter((e) => e.action === action && (!entityType || e.entityType === entityType));

    const lineTarget = { kind: "line", name: "Blue jar" };
    expect(of("void.create")).toEqual([
      expect.objectContaining({
        category: "problems",
        params: { quantity: 1 },
        target: lineTarget,
      }),
      expect.objectContaining({
        category: "problems",
        params: { quantity: 2 },
        target: lineTarget,
      }),
    ]);
    expect(of("void.undo")[0]).toMatchObject({ category: "problems", target: lineTarget });
    expect(of("void.resolve")[0]).toMatchObject({
      category: "problems",
      params: { resolution: "REFUNDED" },
      target: lineTarget,
    });
    expect(of("issue.report")[0]).toMatchObject({
      category: "problems",
      params: { type: "DAMAGED_ITEM", severity: "MAJOR" },
      target: lineTarget,
    });
    expect(of("issue.update")[0]).toMatchObject({ category: "problems" });
    expect(of("issue.setResponsible")[0]).toMatchObject({
      category: "problems",
      params: { name: "Test User" },
    });
    expect(of("issue.resolve")[0]).toMatchObject({
      category: "problems",
      params: { outcome: "RESOLVED" },
    });

    const notes = entries.filter((e) => e.entityType === "Note");
    expect(notes.map((e) => e.action).sort()).toEqual(["create", "create", "delete", "update"]);
    for (const e of notes) expect(e.category).toBe("notes");
    // The Notes tab applies note rules; the feed never carries the text.
    const sent = JSON.stringify(notes);
    for (const text of ["Secret wording", "Edited secret", "Short-lived"]) {
      expect(sent).not.toContain(text);
    }
  });
});
