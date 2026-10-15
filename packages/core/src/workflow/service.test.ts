import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { beginPicking, completePacking, completePicking, completeQa, transition } from "./service";

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
