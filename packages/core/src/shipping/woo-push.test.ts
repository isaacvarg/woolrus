import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { StoreError } from "../adapters/woocommerce/errors";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { noteText, pushToWoo } from "./woo-push";

// The woo.push job with tracking off (SPEC-shipping success criteria 4, 6 and 7).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/** A shipped order that exists in the fake store, with one tracked label per package. */
async function shipped(store: FakeStoreAdapter, numbers: string[] = ["9400111"]) {
  const woo = store.addOrder();
  const built = await createOrder(db, {
    status: "COMPLETED",
    packages: numbers.map(() => ({ label: "ACTIVE" as const })),
  });
  const labels = await db.shippingLabel.findMany({
    where: { package: { orderId: built.order.id } },
    orderBy: { package: { number: "asc" } },
  });
  for (const [i, label] of labels.entries()) {
    await db.shippingLabel.update({
      where: { id: label.id },
      data: { trackingNumber: numbers[i] },
    });
  }
  const order = await db.order.update({
    where: { id: built.order.id },
    data: { wooOrderId: woo.id, wooPushStatus: "PENDING" },
  });
  return { order, wooId: woo.id };
}

const addNote = async (
  orderId: string,
  content: string,
  visibility: "INTERNAL" | "CUSTOMER",
  authorId?: string,
) => db.note.create({ data: { orderId, content, visibility, authorId } });

const state = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const methods = (store: FakeStoreAdapter) => store.calls.map((c) => c.method);

describe("pushToWoo tracking off", () => {
  it("posts the tracking note, then every note, then completes, and records SUCCEEDED", async () => {
    const store = new FakeStoreAdapter();
    const { order, wooId } = await shipped(store, ["1Z999", "9400111"]);
    const author = await createActor(db, ["PACKER"]);
    await addNote(order.id, "Customer <b>hi</b>", "CUSTOMER");
    await addNote(order.id, "Careful with glass", "INTERNAL", author.userId ?? undefined);

    await expect(pushToWoo(db, store, { orderId: order.id })).resolves.toEqual({
      outcome: "succeeded",
    });

    expect(methods(store).filter((m) => m.startsWith("add") || m === "completeOrder")).toEqual([
      "addOrderNote",
      "addOrderNote",
      "addOrderNote",
      "completeOrder",
    ]);
    const notes = store.notesOf(wooId);
    expect(notes[0]).toMatchObject({ customer_note: true });
    expect(notes[0]?.note).toContain("Package 1: USPS 1Z999");
    expect(notes[0]?.note).toContain("Package 2: USPS 9400111");
    expect(notes[0]?.note).not.toMatch(/shipstation/i);
    expect(notes[1]).toMatchObject({ customer_note: true, note: "Customer &lt;b&gt;hi&lt;/b&gt;" });
    expect(notes[2]).toMatchObject({ customer_note: false });
    expect(notes[2]?.note).toMatch(/^\[.+ · Order: .+\] Careful with glass$/);
    expect((await store.getOrder(wooId))?.status).toBe("completed");
    expect(await state(order.id)).toMatchObject({
      wooPushStatus: "SUCCEEDED",
      wooPushError: null,
      wooPushAttempts: 1,
    });
    expect((await state(order.id)).wooPushedAt).not.toBeNull();
    expect((await db.note.findMany()).every((n) => n.wooNoteId !== null)).toBe(true);
    expect(await db.auditEvent.count({ where: { action: "woo.push" } })).toBe(1);
  });

  it("makes no tracking-plugin call and posts the tracking note once across a rerun", async () => {
    const store = new FakeStoreAdapter();
    const { order, wooId } = await shipped(store);
    await pushToWoo(db, store, { orderId: order.id });
    await db.order.update({ where: { id: order.id }, data: { wooPushStatus: "PENDING" } });
    await pushToWoo(db, store, { orderId: order.id });
    expect(store.notesOf(wooId)).toHaveLength(1);
    expect(methods(store).some((m) => /tracking/i.test(m))).toBe(false);
  });

  it("skips an order that isn't waiting for a push", async () => {
    const store = new FakeStoreAdapter();
    const { order } = await shipped(store);
    await db.order.update({ where: { id: order.id }, data: { wooPushStatus: "SUCCEEDED" } });
    await expect(pushToWoo(db, store, { orderId: order.id })).resolves.toEqual({
      outcome: "skipped",
    });
    expect(store.calls).toHaveLength(0);
  });
});

describe("pushToWoo idempotency (SRS §7.1 #8)", () => {
  it.each(["listOrderNotes", "addOrderNote", "completeOrder"] as const)(
    "a job that died at %s and runs again posts nothing twice",
    async (dies) => {
      const store = new FakeStoreAdapter();
      const { order, wooId } = await shipped(store);
      await addNote(order.id, "Internal one", "INTERNAL");
      await addNote(order.id, "For the customer", "CUSTOMER");
      store.failNext(dies, new StoreError("unreachable", "boom"));
      await expect(pushToWoo(db, store, { orderId: order.id })).rejects.toBeInstanceOf(StoreError);

      await pushToWoo(db, store, { orderId: order.id });

      const texts = store.notesOf(wooId).map((n) => n.note);
      expect(new Set(texts).size).toBe(texts.length);
      expect(texts).toHaveLength(3);
      expect(await state(order.id)).toMatchObject({
        wooPushStatus: "SUCCEEDED",
        wooPushAttempts: 2,
      });
    },
  );

  it("matches a note whose response was lost instead of posting it again", async () => {
    const store = new FakeStoreAdapter();
    const { order, wooId } = await shipped(store);
    await addNote(order.id, "Internal one", "INTERNAL");
    store.loseNextNoteResponse(new StoreError("unreachable", "response lost"));
    await expect(pushToWoo(db, store, { orderId: order.id })).rejects.toBeInstanceOf(StoreError);
    expect(store.notesOf(wooId)).toHaveLength(1);

    await pushToWoo(db, store, { orderId: order.id });

    expect(store.notesOf(wooId)).toHaveLength(2);
    expect((await state(order.id)).wooTrackingNoteId).toBe(store.notesOf(wooId)[0]?.id);
  });

  it("gives two identical notes a store note each", async () => {
    const store = new FakeStoreAdapter();
    const { order, wooId } = await shipped(store);
    await addNote(order.id, "same", "CUSTOMER");
    await addNote(order.id, "same", "CUSTOMER");
    await pushToWoo(db, store, { orderId: order.id });
    expect(store.notesOf(wooId).filter((n) => n.note === "same")).toHaveLength(2);
  });
});

describe("pushToWoo failures (FR-SHIP-07)", () => {
  it("keeps the order PENDING with the error while the store is down, then succeeds", async () => {
    const store = new FakeStoreAdapter();
    const { order } = await shipped(store);
    store.failNext("listOrderNotes", new StoreError("unreachable", "down"));

    await expect(pushToWoo(db, store, { orderId: order.id })).rejects.toBeInstanceOf(StoreError);
    expect(await state(order.id)).toMatchObject({
      status: "COMPLETED",
      wooPushStatus: "PENDING",
      wooPushError: "errors.sync.unreachable",
    });

    await pushToWoo(db, store, { orderId: order.id });
    expect(await state(order.id)).toMatchObject({ wooPushStatus: "SUCCEEDED", wooPushError: null });
  });

  it("ends FAILED at once on unauthorized, leaving the order Completed", async () => {
    const store = new FakeStoreAdapter();
    const { order } = await shipped(store);
    store.failNext("listOrderNotes", new StoreError("unauthorized", "401", 401));

    await expect(pushToWoo(db, store, { orderId: order.id })).resolves.toEqual({
      outcome: "failed",
      messageKey: "errors.sync.unauthorized",
    });
    expect(await state(order.id)).toMatchObject({
      status: "COMPLETED",
      wooPushStatus: "FAILED",
      wooPushError: "errors.sync.unauthorized",
    });
    expect(await db.auditEvent.count({ where: { action: "woo.push.failed" } })).toBe(1);
  });

  it.each(["notFound", "rejected"] as const)("ends FAILED at once on %s", async (kind) => {
    const store = new FakeStoreAdapter();
    const { order } = await shipped(store);
    store.failNext("completeOrder", new StoreError(kind, "no"));
    const result = await pushToWoo(db, store, { orderId: order.id });
    expect(result.outcome).toBe("failed");
    expect((await state(order.id)).wooPushStatus).toBe("FAILED");
  });

  it("ends FAILED when the last attempt still fails transiently", async () => {
    const store = new FakeStoreAdapter();
    const { order } = await shipped(store);
    store.failNext("listOrderNotes", new StoreError("rateLimited", "429", 429));
    await expect(
      pushToWoo(db, store, { orderId: order.id }, { finalAttempt: true }),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect((await state(order.id)).wooPushStatus).toBe("FAILED");
  });

  it("fails permanently when WooCommerce isn't configured", async () => {
    const store = new FakeStoreAdapter();
    const { order } = await shipped(store);
    await expect(pushToWoo(db, null, { orderId: order.id })).resolves.toMatchObject({
      outcome: "failed",
    });
  });
});

describe("noteText", () => {
  const base = {
    id: "n",
    visibility: "INTERNAL" as const,
    content: "a & b",
    authorName: null,
    target: { kind: "item" as const, id: "i", label: "Lavender soap ×2" },
    attachments: { photos: 2, voice: 1 },
    createdAt: new Date(),
  };
  it("prefixes internal notes, escapes markup and counts attachments", () => {
    expect(noteText({ ...base, authorName: "Ana" })).toBe(
      "[Ana · Line: Lavender soap ×2] a &amp; b\n(2 photos, 1 voice memo in Woolrus)",
    );
  });
});
