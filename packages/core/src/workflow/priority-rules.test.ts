import type { CreatePriorityRuleInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { ORDER_CHANGED_CHANNEL } from "./notify";
import {
  createPriorityRule,
  deletePriorityRule,
  listPriorityRules,
  recomputePriorities,
  reorderPriorityRules,
  updatePriorityRule,
} from "./priority-rules";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const hour = 3_600_000;
let keySeq = 0;
function input(
  fields: Omit<CreatePriorityRuleInput, "idempotencyKey" | "enabled"> & {
    enabled?: boolean;
  },
): CreatePriorityRuleInput {
  keySeq += 1;
  return { idempotencyKey: `rule-key-${keySeq}`, enabled: true, ...fields };
}

const rushRule = input({
  name: "Rush Order",
  condition: { type: "lineItem", match: "sku", value: "RUSH-ORDER" },
  priority: 2,
});

const priorityOf = async (id: string) =>
  (await db.order.findUniqueOrThrow({ where: { id }, select: { priority: true } })).priority;

describe("priority rules service", () => {
  it("creates, lists in position order, updates and deletes rules, each audited", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const rush = await createPriorityRule(db, admin, rushRule);
    const express = await createPriorityRule(
      db,
      admin,
      input({
        name: "Express",
        condition: { type: "shippingMethod", contains: "express" },
        priority: 1,
      }),
    );
    expect(rush).toMatchObject({ name: "Rush Order", enabled: true, priority: 2, position: 0 });
    expect(express.position).toBe(1);

    const edited = await updatePriorityRule(db, admin, { id: express.id, enabled: false });
    expect(edited).toMatchObject({ enabled: false, name: "Express", priority: 1 });
    expect((await listPriorityRules(db, admin)).map((r) => r.name)).toEqual([
      "Rush Order",
      "Express",
    ]);

    expect(await deletePriorityRule(db, admin, { id: rush.id })).toEqual([edited]);

    const audit = await db.auditEvent.findMany({
      where: { entityType: "PriorityRule" },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => [e.entityId, e.action])).toEqual([
      [rush.id, "create"],
      [express.id, "create"],
      [express.id, "update"],
      [rush.id, "delete"],
    ]);
    expect(audit[2]?.before).toMatchObject({ enabled: true });
    expect(audit[2]?.after).toMatchObject({ enabled: false });
  });

  it("returns the original rule when a create is replayed", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const first = await createPriorityRule(db, admin, rushRule);
    expect(await createPriorityRule(db, admin, rushRule)).toEqual(first);
    expect(await db.priorityRule.count()).toBe(1);
  });

  it("reorders by the full id list and refuses a list that doesn't match the rules", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const a = await createPriorityRule(db, admin, rushRule);
    const b = await createPriorityRule(
      db,
      admin,
      input({ name: "Old", condition: { type: "orderAge", minHours: 48 }, priority: 1 }),
    );

    const reordered = await reorderPriorityRules(db, admin, { ids: [b.id, a.id] });
    expect(reordered.map((r) => [r.name, r.position])).toEqual([
      ["Old", 0],
      ["Rush Order", 1],
    ]);

    await expect(reorderPriorityRules(db, admin, { ids: [a.id] })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.conflict",
    });
    await expect(
      reorderPriorityRules(db, admin, { ids: [a.id, crypto.randomUUID()] }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
  });

  it("gives not found for a missing rule", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const id = crypto.randomUUID();
    await expect(updatePriorityRule(db, admin, { id, enabled: false })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(deletePriorityRule(db, admin, { id })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("needs settings.manage for every call", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const admin = await createActor(db, ["ADMIN"]);
    const rule = await createPriorityRule(db, admin, rushRule);
    const calls = [
      () => listPriorityRules(db, picker),
      () => createPriorityRule(db, picker, input({ ...rushRule })),
      () => updatePriorityRule(db, picker, { id: rule.id, enabled: false }),
      () => deletePriorityRule(db, picker, { id: rule.id }),
      () => reorderPriorityRules(db, picker, { ids: [rule.id] }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrowError("errors.forbidden");
  });
});

describe("recompute on rule changes", () => {
  it("updates open orders in the same change, without bumping their version", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order: rushed } = await createOrder(db, {
      lines: [{}, { sku: "RUSH-ORDER", physical: false }],
    });
    const { order: plain } = await createOrder(db);
    const { order: shipped } = await createOrder(db, {
      status: "COMPLETED",
      lines: [{ sku: "RUSH-ORDER", physical: false }],
    });

    const rule = await createPriorityRule(db, admin, rushRule);
    expect(await priorityOf(rushed.id)).toBe(2);
    expect(await priorityOf(plain.id)).toBe(0);
    expect(await priorityOf(shipped.id)).toBe(0);
    const after = await db.order.findUniqueOrThrow({ where: { id: rushed.id } });
    expect(after.version).toBe(rushed.version);

    await updatePriorityRule(db, admin, { id: rule.id, priority: 1 });
    expect(await priorityOf(rushed.id)).toBe(1);
    await updatePriorityRule(db, admin, { id: rule.id, enabled: false });
    expect(await priorityOf(rushed.id)).toBe(0);
    await updatePriorityRule(db, admin, { id: rule.id, enabled: true });
    await deletePriorityRule(db, admin, { id: rule.id });
    expect(await priorityOf(rushed.id)).toBe(0);
  });

  it("resets orders to Normal when no rule matches any more", async () => {
    const { order } = await createOrder(db, { priority: 2 });
    expect(await recomputePriorities(db)).toEqual({ updated: 1 });
    expect(await priorityOf(order.id)).toBe(0);
  });
});

describe("recomputePriorities", () => {
  it("raises an order once it crosses an age threshold", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const now = new Date("2026-10-15T12:00:00Z");
    const { order } = await createOrder(db, { orderedAt: new Date(now.getTime() - 47 * hour) });
    await createPriorityRule(
      db,
      admin,
      input({ name: "Old", condition: { type: "orderAge", minHours: 48 }, priority: 1 }),
      { now },
    );
    expect(await priorityOf(order.id)).toBe(0);

    expect(await recomputePriorities(db, { now: new Date(now.getTime() + hour) })).toEqual({
      updated: 1,
    });
    expect(await priorityOf(order.id)).toBe(1);
    // Nothing changed since: no write.
    expect(await recomputePriorities(db, { now: new Date(now.getTime() + 2 * hour) })).toEqual({
      updated: 0,
    });
  });

  it("limits the recompute to the given orders", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createPriorityRule(db, admin, rushRule);
    const rush = { lines: [{ sku: "RUSH-ORDER", physical: false }] };
    const { order: imported } = await createOrder(db, rush);
    const { order: other } = await createOrder(db, rush);

    expect(await recomputePriorities(db, { orderIds: [imported.id] })).toEqual({ updated: 1 });
    expect(await priorityOf(imported.id)).toBe(2);
    expect(await priorityOf(other.id)).toBe(0);
  });

  it("covers held orders, and skips completed and cancelled ones", async () => {
    const { order: held } = await createOrder(db, {
      status: "ON_HOLD",
      heldFromStatus: "PACKING",
      holdReason: "Waiting",
      priority: 1,
    });
    const { order: cancelled } = await createOrder(db, { status: "CANCELLED", priority: 1 });
    await recomputePriorities(db);
    expect(await priorityOf(held.id)).toBe(0);
    expect(await priorityOf(cancelled.id)).toBe(1);
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

    it("sends order_changed for each changed order only", async () => {
      const admin = await createActor(db, ["ADMIN"]);
      const { order: rushed } = await createOrder(db, {
        status: "PACKING",
        lines: [{ sku: "RUSH-ORDER", physical: false }],
      });
      await createOrder(db);

      await createPriorityRule(db, admin, rushRule);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(received).toEqual([{ id: rushed.id, status: "PACKING" }]);
    });
  });
});
