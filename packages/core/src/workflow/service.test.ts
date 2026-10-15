import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import {
  beginPicking,
  cancel,
  completePacking,
  completePicking,
  completeQa,
  forceStatus,
  hold,
  repack,
  resume,
  ship,
  transition,
} from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/** An order that meets every gate up to `status`, claimed by `claimedById`. */
function readyToComplete(status: "PICKING" | "PACKING" | "QA", claimedById: string) {
  return createOrder(db, {
    status,
    claimedById,
    lines: [{ name: "Tee", quantity: 2, pickStatus: "PICKED" }],
    packages:
      status === "PICKING"
        ? []
        : [
            {
              items: [{ line: 0, quantity: 2, verified: status === "QA" }],
              rates: status === "QA" ? [{ selected: true }] : [],
              label: status === "QA" ? "ACTIVE" : null,
            },
          ],
  });
}

describe("beginPicking", () => {
  it("moves a Pending order to Picking and claims it for the actor", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { statusChangedAt: minutesAgo(60) });

    const updated = await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(updated).toMatchObject({ status: "PICKING", version: 2, claimedById: picker.userId });
    expect(updated.claimedAt).not.toBeNull();
    expect(updated.statusChangedAt.getTime()).toBeGreaterThan(order.statusChangedAt.getTime());
  });

  it("writes exactly one stage event and one audit event", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(await db.orderStageEvent.findMany({ where: { orderId: order.id } })).toMatchObject([
      {
        fromStatus: "PENDING",
        toStatus: "PICKING",
        actorId: picker.userId,
        stationId: null,
        reason: null,
      },
    ]);
    expect(await db.auditEvent.findMany({ where: { entityId: order.id } })).toMatchObject([
      { entityType: "Order", action: "order.beginPicking", actorId: picker.userId },
    ]);
  });

  it("takes over an expired claim without asking", async () => {
    const [picker, other] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, {
      claimedById: other.userId,
      claimedAt: minutesAgo(31),
    });

    const updated = await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(updated.claimedById).toBe(picker.userId);
  });

  it("refuses an order someone else has a live claim on, naming them, and changes nothing", async () => {
    const [picker, other] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    await db.user.update({ where: { id: other.userId }, data: { name: "Ana Ruiz" } });
    const { order } = await createOrder(db, {
      claimedById: other.userId,
      claimedAt: minutesAgo(5),
    });

    await expect(
      beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.claimedByOther",
      params: { name: "Ana Ruiz" },
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: "PENDING",
      version: 1,
      claimedById: other.userId,
    });
    expect(await db.orderStageEvent.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("begins picking an order the actor already claimed", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, {
      claimedById: picker.userId,
      claimedAt: minutesAgo(5),
    });

    const updated = await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(updated).toMatchObject({ status: "PICKING", claimedById: picker.userId });
  });
});

describe("stage completions", () => {
  it("completePicking moves to Packing and clears the claim", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await readyToComplete("PICKING", picker.userId);

    const updated = await completePicking(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(updated).toMatchObject({
      status: "PACKING",
      version: 2,
      claimedById: null,
      claimedAt: null,
    });
  });

  it("completePacking moves to QA", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { order } = await readyToComplete("PACKING", packer.userId);

    const updated = await completePacking(db, packer, { orderId: order.id, expectedVersion: 1 });

    expect(updated).toMatchObject({ status: "QA", claimedById: null });
  });

  it("completeQa moves to Ready", async () => {
    const qa = await createActor(db, ["QA"]);
    const { order } = await readyToComplete("QA", qa.userId);

    const updated = await completeQa(db, qa, { orderId: order.id, expectedVersion: 1 });

    expect(updated).toMatchObject({ status: "READY", claimedById: null });
  });
});

describe("claim rule", () => {
  it("refuses a completion when nobody holds the claim", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, {
      status: "PICKING",
      lines: [{ pickStatus: "PICKED" }],
    });

    await expect(
      completePicking(db, picker, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.claimRequired",
    });
  });

  it("refuses a completion when someone else holds the claim", async () => {
    const [picker, other] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await readyToComplete("PICKING", other.userId);

    await expect(
      completePicking(db, picker, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
  });

  it("treats the actor's own expired claim as no claim", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await readyToComplete("PICKING", picker.userId);
    const later = new Date(Date.now() + 31 * 60_000);

    await expect(
      db.$transaction((tx) =>
        transition(
          tx,
          picker,
          { orderId: order.id, expectedVersion: 1, to: "PACKING", kind: "completePicking" },
          {
            now: later,
          },
        ),
      ),
    ).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });
  });

  it("uses the claim expiry from settings", async () => {
    await db.settings.create({ data: { claimExpiryMinutes: 120 } });
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await readyToComplete("PICKING", picker.userId);
    const later = new Date(Date.now() + 60 * 60_000);

    const updated = await db.$transaction((tx) =>
      transition(
        tx,
        picker,
        { orderId: order.id, expectedVersion: 1, to: "PACKING", kind: "completePicking" },
        {
          now: later,
        },
      ),
    );

    expect(updated.status).toBe("PACKING");
  });
});

describe("gate refusal (SC 3)", () => {
  it("reports the unmet list and changes nothing", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { order } = await createOrder(db, {
      status: "PACKING",
      claimedById: packer.userId,
      lines: [{ name: "Tee", quantity: 2, pickStatus: "PICKED" }],
      packages: [{ items: [{ line: 0, quantity: 1 }] }],
    });

    await expect(
      completePacking(db, packer, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.gateFailed",
      unmet: [
        {
          messageKey: "errors.workflow.gate.lineUnderPacked",
          params: { line: "Tee", packed: 1, expected: 2 },
        },
      ],
    });

    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
    expect(await db.orderStageEvent.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("refusals", () => {
  it("refuses a stale version", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { version: 3 });

    await expect(
      beginPicking(db, picker, { orderId: order.id, expectedVersion: 2 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.stale",
    });
  });

  it("refuses a move the machine doesn't allow", async () => {
    const qa = await createActor(db, ["QA"]);
    const { order } = await createOrder(db, { status: "PENDING", claimedById: qa.userId });

    await expect(
      completeQa(db, qa, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.illegalTransition",
    });
  });

  it("refuses a missing order", async () => {
    const picker = await createActor(db, ["PICKER"]);

    await expect(
      beginPicking(db, picker, {
        orderId: "00000000-0000-7000-8000-000000000000",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("requires a reason where the machine does", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await createOrder(db);

    await expect(
      db.$transaction((tx) =>
        transition(tx, admin, {
          orderId: order.id,
          expectedVersion: 1,
          to: "ON_HOLD",
          kind: "hold",
          reason: "  ",
        }),
      ),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", fields: { reason: "errors.field.required" } });
  });
});

describe("optimistic locking (SC 5)", () => {
  it("lets exactly one of two concurrent transitions with the same version through", async () => {
    const [a, b] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db);

    const results = await Promise.allSettled([
      beginPicking(db, a, { orderId: order.id, expectedVersion: 1 }),
      beginPicking(db, b, { orderId: order.id, expectedVersion: 1 }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([
      { reason: { messageKey: "errors.workflow.stale" } },
    ]);
    expect(await db.orderStageEvent.count()).toBe(1);
  });
});

describe("permissions (SC 4)", () => {
  const roles: Role[] = ["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"];
  const cases = [
    { fn: beginPicking, name: "beginPicking", status: "PENDING", allowed: ["ADMIN", "PICKER"] },
    {
      fn: completePicking,
      name: "completePicking",
      status: "PICKING",
      allowed: ["ADMIN", "PICKER"],
    },
    {
      fn: completePacking,
      name: "completePacking",
      status: "PACKING",
      allowed: ["ADMIN", "PACKER"],
    },
    { fn: completeQa, name: "completeQa", status: "QA", allowed: ["ADMIN", "QA"] },
  ] as const;

  it.each(
    cases.flatMap((c) =>
      roles.map((role) => ({ ...c, role, ok: (c.allowed as readonly Role[]).includes(role) })),
    ),
  )("$name as $role: allowed=$ok", async ({ fn, status, role, ok }) => {
    const actor = await createActor(db, [role]);
    const { order } =
      status === "PENDING" ? await createOrder(db) : await readyToComplete(status, actor.userId);

    const result = fn(db, actor, { orderId: order.id, expectedVersion: 1 });

    if (ok) await expect(result).resolves.toMatchObject({ version: 2 });
    else await expect(result).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

/** A Ready order with one package and a label in `label` status. */
const readyOrder = (
  label: "ACTIVE" | "PURCHASING" | "VOID_REQUESTED" | "VOID_REJECTED" | "VOIDED" | null = "ACTIVE",
) =>
  createOrder(db, {
    status: "READY",
    lines: [{ quantity: 1, pickStatus: "PICKED" }],
    packages: [
      { items: [{ line: 0, quantity: 1, verified: true }], rates: [{ selected: true }], label },
    ],
  });

describe("hold and resume (SC 7)", () => {
  it.each(["PENDING", "PICKING", "PACKING", "QA", "READY"] as const)(
    "holds from %s and resumes back to it",
    async (status) => {
      const picker = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db, { status, claimedById: picker.userId });

      const held = await hold(db, picker, {
        orderId: order.id,
        expectedVersion: 1,
        reason: " Customer called ",
      });
      expect(held).toMatchObject({
        status: "ON_HOLD",
        holdReason: "Customer called",
        heldFromStatus: status,
        claimedById: null,
      });

      const resumed = await resume(db, picker, { orderId: order.id, expectedVersion: 2 });
      expect(resumed).toMatchObject({ status, holdReason: null, heldFromStatus: null, version: 3 });
    },
  );

  it("requires a reason", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    await expect(
      hold(db, picker, { orderId: order.id, expectedVersion: 1, reason: "" }),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      fields: { reason: "errors.field.required" },
    });
  });

  it.each(["ON_HOLD", "COMPLETED", "CANCELLED"] as const)(
    "can't hold a %s order",
    async (status) => {
      const picker = await createActor(db, ["PICKER"]);
      const { order } = await createOrder(db, { status });

      await expect(
        hold(db, picker, { orderId: order.id, expectedVersion: 1, reason: "x" }),
      ).rejects.toMatchObject({
        messageKey: "errors.workflow.illegalTransition",
      });
    },
  );

  it("can't resume an order that isn't held, or has nowhere to return to", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order: pending } = await createOrder(db);
    const { order: orphan } = await createOrder(db, { status: "ON_HOLD", heldFromStatus: null });

    for (const order of [pending, orphan]) {
      await expect(
        resume(db, picker, { orderId: order.id, expectedVersion: 1 }),
      ).rejects.toMatchObject({
        messageKey: "errors.workflow.illegalTransition",
      });
    }
  });
});

describe("cancel (SC 7)", () => {
  it("cancels with a reason and no live labels", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await readyOrder("VOIDED");

    const cancelled = await cancel(db, admin, {
      orderId: order.id,
      expectedVersion: 1,
      reason: "Fraud",
    });

    expect(cancelled).toMatchObject({ status: "CANCELLED", version: 2 });
  });

  it.each(["PURCHASING", "ACTIVE", "VOID_REQUESTED", "VOID_REJECTED"] as const)(
    "is refused with a %s label",
    async (label) => {
      const admin = await createActor(db, ["ADMIN"]);
      const { order } = await readyOrder(label);

      await expect(
        cancel(db, admin, { orderId: order.id, expectedVersion: 1, reason: "Fraud" }),
      ).rejects.toMatchObject({
        messageKey: "errors.workflow.gateFailed",
        unmet: [{ messageKey: "errors.workflow.gate.packageLiveLabel", params: { package: 1 } }],
      });
    },
  );

  it("cancels a held order", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await createOrder(db, {
      status: "ON_HOLD",
      heldFromStatus: "PICKING",
      holdReason: "x",
    });

    const cancelled = await cancel(db, admin, {
      orderId: order.id,
      expectedVersion: 1,
      reason: "Fraud",
    });

    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      holdReason: null,
      heldFromStatus: null,
    });
  });

  it.each(["PICKER", "PACKER", "QA", "SHIPPER"] as const)("is forbidden to %s", async (role) => {
    const actor = await createActor(db, [role]);
    const { order } = await createOrder(db);

    await expect(
      cancel(db, actor, { orderId: order.id, expectedVersion: 1, reason: "x" }),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("forceStatus", () => {
  it("skips gates and claims", async () => {
    const [admin, picker] = [await createActor(db, ["ADMIN"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, { status: "PICKING", claimedById: picker.userId });

    const forced = await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: 1,
      to: "READY",
      reason: "Packed by hand",
    });

    expect(forced).toMatchObject({ status: "READY", claimedById: null });
  });

  it("requires a reason", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await createOrder(db);

    await expect(
      forceStatus(db, admin, { orderId: order.id, expectedVersion: 1, to: "READY", reason: " " }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it.each(["PICKER", "PACKER", "QA", "SHIPPER"] as const)("is forbidden to %s", async (role) => {
    const actor = await createActor(db, [role]);
    const { order } = await createOrder(db);

    await expect(
      forceStatus(db, actor, { orderId: order.id, expectedVersion: 1, to: "READY", reason: "x" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("won't reopen a Completed order with a live label, but will cancel it", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await createOrder(db, {
      status: "COMPLETED",
      lines: [{ pickStatus: "PICKED" }],
      packages: [{ items: [{ line: 0, quantity: 1 }], label: "ACTIVE" }],
    });

    await expect(
      forceStatus(db, admin, { orderId: order.id, expectedVersion: 1, to: "PACKING", reason: "x" }),
    ).rejects.toMatchObject({ messageKey: "errors.workflow.gateFailed" });

    const cancelled = await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: 1,
      to: "CANCELLED",
      reason: "Lost in transit",
    });
    expect(cancelled).toMatchObject({ status: "CANCELLED", completedAt: null });
  });
});

describe("repack and ship (caller's transaction)", () => {
  it("repack returns a Ready order to Packing", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { order } = await readyOrder("VOIDED");

    const repacked = await db.$transaction((tx) =>
      repack(tx, packer, { orderId: order.id, expectedVersion: 1, reason: "Wrong box" }),
    );

    expect(repacked).toMatchObject({ status: "PACKING", version: 2 });
  });

  it("repack is refused with a live label, without a reason, and to a Picker", async () => {
    const [packer, picker] = [await createActor(db, ["PACKER"]), await createActor(db, ["PICKER"])];
    const { order } = await readyOrder("ACTIVE");
    const run = (actor: typeof packer, reason: string) =>
      db.$transaction((tx) => repack(tx, actor, { orderId: order.id, expectedVersion: 1, reason }));

    await expect(run(packer, "Wrong box")).rejects.toMatchObject({
      messageKey: "errors.workflow.gateFailed",
    });
    await expect(run(packer, "")).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(run(picker, "Wrong box")).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("ship completes a Ready order whose packages have active labels", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const { order } = await readyOrder("ACTIVE");

    const shipped = await db.$transaction((tx) =>
      ship(tx, shipper, { orderId: order.id, expectedVersion: 1 }),
    );

    expect(shipped).toMatchObject({ status: "COMPLETED", claimedById: null });
    expect(shipped.completedAt).not.toBeNull();
  });

  it("ship is refused without an active label, and to a Packer", async () => {
    const [shipper, packer] = [
      await createActor(db, ["SHIPPER"]),
      await createActor(db, ["PACKER"]),
    ];
    const { order } = await readyOrder("VOIDED");
    const run = (actor: typeof shipper) =>
      db.$transaction((tx) => ship(tx, actor, { orderId: order.id, expectedVersion: 1 }));

    await expect(run(shipper)).rejects.toMatchObject({
      unmet: [{ messageKey: "errors.workflow.gate.packageNoLabel", params: { package: 1 } }],
    });
    await expect(run(packer)).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("ship rolls back with the caller's transaction", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const { order } = await readyOrder("ACTIVE");

    await expect(
      db.$transaction(async (tx) => {
        await ship(tx, shipper, { orderId: order.id, expectedVersion: 1 });
        throw new Error("Woo push enqueue failed");
      }),
    ).rejects.toThrow("Woo push enqueue failed");

    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
    expect(await db.orderStageEvent.count()).toBe(0);
  });
});

describe("history and audit (SC 8)", () => {
  it("writes one stage event and one audit event per move, with actor, from, to and reason", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { order } = await createOrder(db);

    await hold(db, admin, { orderId: order.id, expectedVersion: 1, reason: "Address check" });
    await resume(db, admin, { orderId: order.id, expectedVersion: 2 });
    await cancel(db, admin, {
      orderId: order.id,
      expectedVersion: 3,
      reason: "Customer cancelled",
    });

    const events = await db.orderStageEvent.findMany({
      where: { orderId: order.id },
      orderBy: { at: "asc" },
    });
    expect(events).toMatchObject([
      {
        fromStatus: "PENDING",
        toStatus: "ON_HOLD",
        reason: "Address check",
        actorId: admin.userId,
      },
      { fromStatus: "ON_HOLD", toStatus: "PENDING", reason: null, actorId: admin.userId },
      {
        fromStatus: "PENDING",
        toStatus: "CANCELLED",
        reason: "Customer cancelled",
        actorId: admin.userId,
      },
    ]);
    const audit = await db.auditEvent.findMany({
      where: { entityId: order.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["order.hold", "order.resume", "order.cancel"]);
    expect(audit[2]?.after).toMatchObject({ status: "CANCELLED", reason: "Customer cancelled" });
  });
});
