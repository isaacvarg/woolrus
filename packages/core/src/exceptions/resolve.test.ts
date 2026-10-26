import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { Actor } from "../permissions";
import { listVoids, voidCounts } from "./queries";
import { resolveVoids, undoVoid, voidItem } from "./voids";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const reason = "Out of stock";
const notes = "Refunded $14 in Woo";

/** A picker voids `quantity` of a new order's line; returns what the admin needs to resolve it. */
async function voided(spec: Parameters<typeof createOrder>[1] = {}, at = new Date()) {
  const picker = await createActor(db, ["PICKER"]);
  const built = await createOrder(db, { lines: [{ quantity: 3 }], ...spec });
  const orderItemId = built.items[0]?.id as string;
  const result = await voidItem(
    db,
    picker,
    { orderId: built.order.id, orderItemId, quantity: 1, reason },
    { now: at },
  );
  return { ...built, picker, orderItemId, voidId: result.void.id };
}

const asAdmin = () => createActor(db, ["ADMIN"]);

describe("resolveVoids", () => {
  it("resolves voids across orders in one call, recording who, what and the note", async () => {
    const admin = await asAdmin();
    const a = await voided();
    const b = await voided();
    // The order shipped after the void: resolving doesn't care about its status.
    await db.order.update({ where: { id: b.order.id }, data: { status: "COMPLETED" } });

    const result = await resolveVoids(db, admin, {
      voidIds: [a.voidId, b.voidId],
      resolution: "REFUNDED",
      notes: `  ${notes} `,
    });

    expect(result).toEqual({ resolved: 2 });
    const rows = await db.itemVoid.findMany({ where: { id: { in: [a.voidId, b.voidId] } } });
    for (const row of rows) {
      expect(row).toMatchObject({
        resolution: "REFUNDED",
        resolutionNotes: notes,
        resolvedById: admin.userId,
        wooRefundId: null,
      });
      expect(row.resolvedAt).toBeInstanceOf(Date);
    }
    const audit = await db.auditEvent.findMany({ where: { action: "void.resolve" } });
    expect(audit).toHaveLength(2);
  });

  it("is all or nothing: one resolved void fails the call and changes nothing", async () => {
    const admin = await asAdmin();
    const a = await voided();
    const b = await voided();
    await resolveVoids(db, admin, {
      voidIds: [b.voidId],
      resolution: "HANDLED_MANUALLY",
      notes,
    });

    await expect(
      resolveVoids(db, admin, { voidIds: [a.voidId, b.voidId], resolution: "REFUNDED", notes }),
    ).rejects.toMatchObject({ messageKey: "errors.voids.alreadyResolved" });
    expect(
      (await db.itemVoid.findUniqueOrThrow({ where: { id: a.voidId } })).resolvedAt,
    ).toBeNull();
  });

  it("refuses an undone void, an unknown void and a missing note", async () => {
    const admin = await asAdmin();
    const a = await voided();
    await undoVoid(db, a.picker, { voidId: a.voidId });

    await expect(
      resolveVoids(db, admin, { voidIds: [a.voidId], resolution: "REFUNDED", notes }),
    ).rejects.toMatchObject({ messageKey: "errors.voids.alreadyUndone" });
    await expect(
      resolveVoids(db, admin, {
        voidIds: ["00000000-0000-7000-8000-000000000000"],
        resolution: "REFUNDED",
        notes,
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    const b = await voided();
    await expect(
      resolveVoids(db, admin, { voidIds: [b.voidId], resolution: "REFUNDED", notes: "  " }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("forbids everyone but an admin", async () => {
    const a = await voided();
    for (const roles of [["PICKER"], ["PACKER"], ["QA"]] as Actor["roles"][]) {
      const actor = await createActor(db, roles);
      await expect(
        resolveVoids(db, actor, { voidIds: [a.voidId], resolution: "REFUNDED", notes }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });

  it("can't be undone once resolved, and leaves the order's version alone", async () => {
    const admin = await asAdmin();
    const a = await voided();
    const before = await db.order.findUniqueOrThrow({ where: { id: a.order.id } });
    await resolveVoids(db, admin, { voidIds: [a.voidId], resolution: "LINE_EDITED", notes });

    await expect(undoVoid(db, a.picker, { voidId: a.voidId })).rejects.toMatchObject({
      messageKey: "errors.voids.alreadyResolved",
    });
    const after = await db.order.findUniqueOrThrow({ where: { id: a.order.id } });
    expect(after.version).toBe(before.version);
  });
});

describe("listVoids and voidCounts", () => {
  it("lists orders with unresolved voids, newest first, and counts agree", async () => {
    const admin = await asAdmin();
    const old = await voided({ number: "1001" }, new Date("2026-01-01T10:00:00Z"));
    const recent = await voided({ number: "1002" }, new Date("2026-01-02T10:00:00Z"));
    const done = await voided({ number: "1003" }, new Date("2026-01-03T10:00:00Z"));
    await resolveVoids(db, admin, { voidIds: [done.voidId], resolution: "REFUNDED", notes });

    const page = await listVoids(db, admin, { status: "unresolved", limit: 50 });
    expect(page.groups.map((g) => g.order.number)).toEqual(["1002", "1001"]);
    expect(page.groups[0]?.voids).toMatchObject([
      { id: recent.voidId, lineName: expect.any(String), quantity: 1, reason, stage: "INTAKE" },
    ]);
    expect(page.groups[0]?.order).toMatchObject({ id: recent.order.id, status: "PENDING" });
    expect(page.nextCursor).toBeNull();
    expect(await voidCounts(db, admin)).toEqual({ unresolvedOrders: 2 });
    expect(old.voidId).toBeTruthy();

    const resolved = await listVoids(db, admin, { status: "resolved", limit: 50 });
    expect(resolved.groups.map((g) => g.order.number)).toEqual(["1003"]);
    expect(resolved.groups[0]?.voids[0]?.resolution).toBe("REFUNDED");
  });

  it("excludes undone voids from Unresolved and counts an order once", async () => {
    const admin = await asAdmin();
    const a = await voided({ number: "2001" });
    await voidItem(db, a.picker, {
      orderId: a.order.id,
      orderItemId: a.orderItemId,
      quantity: 1,
      reason,
    });
    const b = await voided({ number: "2002" });
    await undoVoid(db, b.picker, { voidId: b.voidId });

    expect(await voidCounts(db, admin)).toEqual({ unresolvedOrders: 1 });
    const page = await listVoids(db, admin, { status: "unresolved", limit: 50 });
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0]?.voids).toHaveLength(2);
  });

  it("searches by order-number prefix or customer, pages with a cursor, and needs order.read", async () => {
    const admin = await asAdmin();
    await voided(
      { number: "3001", customerName: "Ada Lovelace" },
      new Date("2026-02-01T00:00:00Z"),
    );
    await voided(
      { number: "3002", customerName: "Grace Hopper" },
      new Date("2026-02-02T00:00:00Z"),
    );
    await voided({ number: "4001", customerName: "Alan Turing" }, new Date("2026-02-03T00:00:00Z"));

    const byPrefix = await listVoids(db, admin, { status: "unresolved", search: "#30", limit: 50 });
    expect(byPrefix.groups.map((g) => g.order.number)).toEqual(["3002", "3001"]);
    const byName = await listVoids(db, admin, {
      status: "unresolved",
      search: "turing",
      limit: 50,
    });
    expect(byName.groups.map((g) => g.order.number)).toEqual(["4001"]);
    // Prefix means prefix: "01" is not an order-number prefix.
    expect((await listVoids(db, admin, { status: "all", search: "01", limit: 50 })).groups).toEqual(
      [],
    );

    const first = await listVoids(db, admin, { status: "unresolved", limit: 2 });
    expect(first.groups.map((g) => g.order.number)).toEqual(["4001", "3002"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listVoids(db, admin, {
      status: "unresolved",
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.groups.map((g) => g.order.number)).toEqual(["3001"]);
    expect(second.nextCursor).toBeNull();

    const picker = await createActor(db, ["PICKER"]);
    expect((await listVoids(db, picker, { status: "unresolved", limit: 50 })).groups).toHaveLength(
      3,
    );
  });
});
