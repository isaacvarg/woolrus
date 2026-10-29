import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../test/db";
import { recordAudit } from "./audit";
import { systemActor } from "./permissions";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

describe("recordAudit", () => {
  it("records the actor's requestId so an audit row leads to its log lines", async () => {
    const actor = { ...(await createActor(db, ["ADMIN"])), requestId: "req-1" };
    await recordAudit(db, actor, { entityType: "Order", entityId: "o1", action: "test" });
    const row = await db.auditEvent.findFirstOrThrow();
    expect(row.requestId).toBe("req-1");
    expect(row.actorId).toBe(actor.userId);
  });

  it("leaves requestId null when the actor has none (jobs)", async () => {
    await recordAudit(db, systemActor, { entityType: "Order", entityId: "o1", action: "test" });
    expect((await db.auditEvent.findFirstOrThrow()).requestId).toBeNull();
  });
});
