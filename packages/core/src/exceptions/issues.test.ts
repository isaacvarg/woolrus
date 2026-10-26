import type { Db, FulfillmentStage, WorkflowStatus } from "@woolrus/db";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { Actor } from "../permissions";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { reportIssue } from "./issues";
import { hasOpenCriticalIssue, openCriticalIssues } from "./queries";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const base = {
  type: "PACKAGING_DAMAGE",
  severity: "MAJOR",
  description: "  Crushed corner  ",
} as const;

async function setup(spec: Parameters<typeof createOrder>[1] = {}, roles: Actor["roles"] = ["QA"]) {
  const actor = await createActor(db, roles);
  const built = await createOrder(db, { status: "QA", ...spec });
  return { actor, ...built, input: { orderId: built.order.id, ...base } };
}

/** Records that `userId` moved the order into `toStatus`, as the transition functions do. */
const moved = (orderId: string, toStatus: WorkflowStatus, actorId: string | null) =>
  db.orderStageEvent.create({ data: { orderId, toStatus, actorId } });

describe("reportIssue", () => {
  it.each([
    ["PENDING", "INTAKE"],
    ["PICKING", "PICKING"],
    ["PACKING", "PACKING"],
    ["QA", "QA"],
    ["READY", "SHIPPING"],
  ] as const)("takes the discovered stage from the order: %s → %s", async (status, stage) => {
    const { actor, input } = await setup({ status });

    const issue = await reportIssue(db, actor, input);

    expect(issue).toMatchObject({
      type: "PACKAGING_DAMAGE",
      severity: "MAJOR",
      status: "OPEN",
      description: "Crushed corner",
      discoveredStage: stage,
      originStage: null,
      customerReported: false,
    });
    const row = await db.qualityIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.reporterId).toBe(actor.userId);
  });

  it("accepts every type and severity", async () => {
    const { actor, input } = await setup();
    const types = [
      "WRONG_ITEM",
      "DAMAGED_ITEM",
      "MISSING_ITEM",
      "WRONG_QUANTITY",
      "PACKAGING_DAMAGE",
      "LABELING_ERROR",
      "WRONG_BOX_SIZE",
      "OTHER",
    ] as const;
    for (const type of types) await reportIssue(db, actor, { ...input, type });
    for (const severity of ["MINOR", "MAJOR", "CRITICAL"] as const) {
      await reportIssue(db, actor, { ...input, severity });
    }
    expect(await db.qualityIssue.count()).toBe(11);
  });

  it("uses the held-from stage for a held order", async () => {
    const { actor, input } = await setup({ status: "ON_HOLD", heldFromStatus: "PACKING" });
    expect((await reportIssue(db, actor, input)).discoveredStage).toBe("PACKING");
  });

  it("attaches a line and a package of the same order, showing their names", async () => {
    const { actor, input, items, packages } = await setup({
      lines: [{ name: "Lavender Soap", quantity: 2 }],
      packages: [{ items: [{ line: 0, quantity: 2 }] }],
    });

    const issue = await reportIssue(db, actor, {
      ...input,
      orderItemId: items[0]?.id,
      packageId: packages[0]?.id,
    });

    expect(issue).toMatchObject({ lineName: "Lavender Soap", packageNumber: 1, noteCount: 0 });
  });

  it("refuses a line or package from another order", async () => {
    const { actor, input } = await setup();
    const other = await createOrder(db, {
      packages: [{ items: [{ line: 0, quantity: 1 }] }],
    });

    await expect(
      reportIssue(db, actor, { ...input, orderItemId: other.items[0]?.id }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(
      reportIssue(db, actor, { ...input, packageId: other.packages[0]?.id }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(await db.qualityIssue.count()).toBe(0);
  });

  it.each([
    ["empty", " "],
    ["too long", "x".repeat(2001)],
  ])("refuses a description that is %s", async (_name, description) => {
    const { actor, input } = await setup();
    await expect(reportIssue(db, actor, { ...input, description })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
    expect(await db.qualityIssue.count()).toBe(0);
  });

  describe("customer-reported (FR-QI-04)", () => {
    it.each(["READY", "COMPLETED"] as const)("is accepted on a %s order", async (status) => {
      const { actor, input } = await setup({ status });
      const issue = await reportIssue(db, actor, { ...input, customerReported: true });
      expect(issue).toMatchObject({ customerReported: true, discoveredStage: "CUSTOMER" });
    });

    it("is refused while the order is still being worked on", async () => {
      const { actor, input } = await setup({ status: "PACKING" });
      await expect(
        reportIssue(db, actor, { ...input, customerReported: true }),
      ).rejects.toMatchObject({ messageKey: "errors.issues.customerStage" });
    });

    it("is required to report on a completed order", async () => {
      const { actor, input } = await setup({ status: "COMPLETED" });
      await expect(reportIssue(db, actor, input)).rejects.toMatchObject({
        messageKey: "errors.issues.orderClosed",
      });
      expect(await db.qualityIssue.count()).toBe(0);
    });
  });

  it("refuses everything on a cancelled order", async () => {
    const { actor, input } = await setup({ status: "CANCELLED" });
    for (const customerReported of [false, true]) {
      await expect(reportIssue(db, actor, { ...input, customerReported })).rejects.toMatchObject({
        messageKey: "errors.issues.orderClosed",
      });
    }
  });

  it("lets every role report, and refuses someone with no role", async () => {
    for (const role of ["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      const { actor, input } = await setup({}, [role]);
      await reportIssue(db, actor, input);
    }
    expect(await db.qualityIssue.count()).toBe(5);

    const { input } = await setup();
    const nobody = await createActor(db, []);
    await expect(reportIssue(db, nobody, input)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await db.qualityIssue.count()).toBe(5);
  });

  describe("responsible user (FR-QI-03)", () => {
    const originate = async (originStage: FulfillmentStage, spec = {}) => {
      const ctx = await setup(spec);
      const issue = await reportIssue(db, ctx.actor, { ...ctx.input, originStage });
      return { ...ctx, issue };
    };

    it("is the line's picker for an origin in Picking", async () => {
      const picker = await createActor(db, ["PICKER"]);
      const ctx = await setup();
      await db.orderItem.update({
        where: { id: ctx.items[0]?.id },
        data: { pickedById: picker.userId },
      });
      const issue = await reportIssue(db, ctx.actor, {
        ...ctx.input,
        orderItemId: ctx.items[0]?.id,
        originStage: "PICKING",
      });
      expect(issue.responsible?.id).toBe(picker.userId);
      expect(issue.originStage).toBe("PICKING");
    });

    it("falls back to who completed picking when the line has no picker", async () => {
      const completer = await createActor(db, ["PICKER"]);
      const ctx = await setup();
      await moved(ctx.order.id, "PACKING", completer.userId);
      const issue = await reportIssue(db, ctx.actor, { ...ctx.input, originStage: "PICKING" });
      expect(issue.responsible?.id).toBe(completer.userId);
    });

    it("is who completed packing for Packing, and who completed QA for QA", async () => {
      const packer = await createActor(db, ["PACKER"]);
      const checker = await createActor(db, ["QA"]);
      const ctx = await setup({ status: "READY" });
      await moved(ctx.order.id, "QA", packer.userId);
      await moved(ctx.order.id, "READY", checker.userId);

      const packing = await reportIssue(db, ctx.actor, { ...ctx.input, originStage: "PACKING" });
      const qa = await reportIssue(db, ctx.actor, { ...ctx.input, originStage: "QA" });

      expect(packing.responsible?.id).toBe(packer.userId);
      expect(qa.responsible?.id).toBe(checker.userId);
    });

    it("takes the latest event when an order went through a stage twice", async () => {
      const first = await createActor(db, ["PACKER"]);
      const second = await createActor(db, ["PACKER"]);
      const ctx = await setup();
      await db.orderStageEvent.create({
        data: { orderId: ctx.order.id, toStatus: "QA", actorId: first.userId, at: new Date(1000) },
      });
      await db.orderStageEvent.create({
        data: { orderId: ctx.order.id, toStatus: "QA", actorId: second.userId, at: new Date(2000) },
      });
      const issue = await reportIssue(db, ctx.actor, { ...ctx.input, originStage: "PACKING" });
      expect(issue.responsible?.id).toBe(second.userId);
    });

    it("is nobody when nothing was recorded, for other origins, or for a system actor", async () => {
      expect((await originate("PACKING")).issue.responsible).toBeNull();
      expect((await originate("SHIPPING")).issue.responsible).toBeNull();
      const ctx = await setup();
      await moved(ctx.order.id, "QA", null);
      const issue = await reportIssue(db, ctx.actor, { ...ctx.input, originStage: "PACKING" });
      expect(issue.responsible).toBeNull();
    });

    it("skips a deactivated user", async () => {
      const gone = await createActor(db, ["PACKER"]);
      await db.user.update({ where: { id: gone.userId }, data: { active: false } });
      const ctx = await setup();
      await moved(ctx.order.id, "QA", gone.userId);
      const issue = await reportIssue(db, ctx.actor, { ...ctx.input, originStage: "PACKING" });
      expect(issue.responsible).toBeNull();
    });

    it("is not set without an origin stage", async () => {
      const ctx = await setup();
      await moved(ctx.order.id, "QA", ctx.actor.userId);
      expect((await reportIssue(db, ctx.actor, ctx.input)).responsible).toBeNull();
    });
  });

  it("records one audit event and tells the queues, without touching the version", async () => {
    const { actor, order, input } = await setup();
    const listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (m) => received.push(m.payload ?? ""));
    await listener.query(`LISTEN ${ORDER_CHANGED_CHANNEL}`);

    const issue = await reportIssue(db, actor, input);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await listener.end();

    const audits = await db.auditEvent.findMany({ where: { entityId: issue.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "issue.report", entityType: "QualityIssue" });
    expect(received.map((p) => JSON.parse(p).id)).toContain(order.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(
      order.version,
    );
  });
});

describe("openCriticalIssues / hasOpenCriticalIssue", () => {
  it("counts only OPEN and CRITICAL issues, per order", async () => {
    const { actor, order, input, items } = await setup({ lines: [{}] });
    const other = await setup();
    const critical = await reportIssue(db, actor, {
      ...input,
      severity: "CRITICAL",
      orderItemId: items[0]?.id,
    });
    await reportIssue(db, actor, { ...input, severity: "MAJOR" });
    const closed = await reportIssue(db, actor, { ...input, severity: "CRITICAL" });
    await db.qualityIssue.update({ where: { id: closed.id }, data: { status: "RESOLVED" } });
    await reportIssue(db, other.actor, { ...other.input, severity: "CRITICAL" });

    expect(await openCriticalIssues(db, order.id)).toEqual([
      { id: critical.id, orderItemId: items[0]?.id, packageId: null, type: "PACKAGING_DAMAGE" },
    ]);
    expect(await hasOpenCriticalIssue(db, order.id)).toBe(true);

    await db.qualityIssue.update({ where: { id: critical.id }, data: { status: "DISMISSED" } });
    expect(await hasOpenCriticalIssue(db, order.id)).toBe(false);
  });
});
