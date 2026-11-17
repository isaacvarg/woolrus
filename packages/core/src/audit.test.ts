import { randomUUID } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../test/db";
import { ORDER_SCOPED_ENTITIES, recordAudit } from "./audit";
import { systemActor } from "./permissions";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@woolrus/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@woolrus/logger")>();
  return {
    ...actual,
    createLogger: (bindings: Record<string, unknown>) => {
      const log = actual.createLogger(bindings);
      return new Proxy(log, {
        get: (target, key) => (key === "warn" ? warn : Reflect.get(target, key)),
      });
    },
  };
});

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockClear();
});

describe("recordAudit", () => {
  it("records the actor's requestId so an audit row leads to its log lines", async () => {
    const actor = { ...(await createActor(db, ["ADMIN"])), requestId: "req-1" };
    const orderId = randomUUID();
    await recordAudit(db, actor, {
      entityType: "Order",
      entityId: orderId,
      orderId,
      action: "order.claim",
    });
    const row = await db.auditEvent.findFirstOrThrow();
    expect(row.requestId).toBe("req-1");
    expect(row.actorId).toBe(actor.userId);
  });

  it("leaves requestId null when the actor has none (jobs)", async () => {
    await recordAudit(db, systemActor, { entityType: "Settings", entityId: "s1", action: "test" });
    expect((await db.auditEvent.findFirstOrThrow()).requestId).toBeNull();
  });
});

// SPEC-order-activity "Order on audit rows": order-scoped rows must carry their order.
describe("recordAudit order guard", () => {
  const missingOrder = (entityType: string) =>
    // An untyped call, as a caller with a widened entity type would make.
    recordAudit(db, systemActor, { entityType, entityId: "x1", action: "order.claim" });

  it.each(ORDER_SCOPED_ENTITIES)(
    "throws in test when a %s row has no orderId",
    async (entityType) => {
      await expect(missingOrder(entityType)).rejects.toThrow(/orderId/);
      expect(await db.auditEvent.count()).toBe(0);
    },
  );

  it("throws in development too", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(missingOrder("Package")).rejects.toThrow(/orderId/);
  });

  it("warns in production and still records the row", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await missingOrder("ShippingLabel");
    expect(await db.auditEvent.count()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "ShippingLabel",
        entityId: "x1",
        action: "order.claim",
      }),
      expect.stringContaining("orderId"),
    );
  });

  it("leaves rows that aren't about an order alone", async () => {
    await recordAudit(db, systemActor, { entityType: "Box", entityId: "b1", action: "box.create" });
    await recordAudit(db, systemActor, {
      entityType: "Approval",
      entityId: "a1",
      action: "approval.grant",
    });
    expect(await db.auditEvent.count()).toBe(2);
  });

  it("types an order-scoped call's action to the registry", () => {
    // Compile-time only: these must fail the type check (see `pnpm typecheck`).
    const typeOnly = () => {
      const order = { entityType: "Order", entityId: "o", orderId: "o" } as const;
      // @ts-expect-error: an unlisted action on an order-scoped entity
      void recordAudit(db, systemActor, { ...order, action: "nope" });
      // @ts-expect-error: another entity's qualified verb
      void recordAudit(db, systemActor, { ...order, action: "archive" });
      const line = { entityType: "OrderItem", entityId: "i", action: "pick.scan" } as const;
      // @ts-expect-error: an order-scoped row needs its orderId
      void recordAudit(db, systemActor, line);
      // A bare verb uses its entity-qualified key.
      void recordAudit(db, systemActor, { ...order, entityType: "Note", action: "create" });
    };
    expect(typeOnly).toBeTypeOf("function");
  });
});
