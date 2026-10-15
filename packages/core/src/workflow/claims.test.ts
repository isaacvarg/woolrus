import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { claim, claimMany, isClaimLive, release, takeOver, touchClaim } from "./claims";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

async function namedActor(name: string, roles: Parameters<typeof createActor>[1]) {
  const actor = await createActor(db, roles);
  await db.user.update({ where: { id: actor.userId }, data: { name } });
  return actor;
}

// Permission comes before any read, so a caller who may not claim learns nothing about the order:
// not whether it exists, its status, nor (for release) its details.
describe("callers who may not claim", () => {
  it.each([
    ["a user without roles", []],
    ["a Shipper", ["SHIPPER"]],
  ] as const)("refuses %s before reading the order", async (_who, roles) => {
    const actor = await createActor(db, roles);
    const { order: ready } = await createOrder(db, { status: "READY" });
    const missing = crypto.randomUUID();

    for (const orderId of [ready.id, missing]) {
      await expect(claim(db, actor, { orderId, expectedVersion: 1 })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
      await expect(
        takeOver(db, actor, { orderId, expectedVersion: 1, confirm: true }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await expect(
        claimMany(db, actor, { orders: [{ id: orderId, expectedVersion: 1 }] }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });

  it("refuses release to a user without roles, even when nothing is claimed", async () => {
    const nobody = await createActor(db, []);
    const { order } = await createOrder(db);

    await expect(release(db, nobody, { orderId: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("isClaimLive", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("is live within the expiry window", () => {
    expect(
      isClaimLive({ claimedById: "u", claimedAt: new Date("2026-10-15T11:31:00Z") }, 30, now),
    ).toBe(true);
  });

  it("is absent once the window has passed, or with no holder", () => {
    expect(
      isClaimLive({ claimedById: "u", claimedAt: new Date("2026-10-15T11:30:00Z") }, 30, now),
    ).toBe(false);
    expect(isClaimLive({ claimedById: null, claimedAt: null }, 30, now)).toBe(false);
  });
});

describe("claim", () => {
  it("claims a Pending order, bumps the version and audits without a stage event", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    const claimed = await claim(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(claimed).toMatchObject({ status: "PENDING", claimedById: picker.userId, version: 2 });
    expect(claimed.claimedAt).not.toBeNull();
    expect(await db.orderStageEvent.count()).toBe(0);
    expect(await db.auditEvent.findMany({ where: { entityId: order.id } })).toMatchObject([
      { action: "order.claim", actorId: picker.userId },
    ]);
  });

  it("needs the permission for the order's stage", async () => {
    const [picker, packer] = [await createActor(db, ["PICKER"]), await createActor(db, ["PACKER"])];
    const { order } = await createOrder(db, { status: "PACKING" });

    await expect(
      claim(db, picker, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(
      claim(db, packer, { orderId: order.id, expectedVersion: 1 }),
    ).resolves.toMatchObject({
      claimedById: packer.userId,
    });
  });

  it.each(["ON_HOLD", "READY", "COMPLETED", "CANCELLED"] as const)(
    "refuses a %s order",
    async (status) => {
      const admin = await createActor(db, ["ADMIN"]);
      const { order } = await createOrder(db, { status });

      await expect(
        claim(db, admin, { orderId: order.id, expectedVersion: 1 }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.workflow.notClaimable",
      });
    },
  );

  it("names the holder when someone else has a live claim (SC 6)", async () => {
    const holder = await namedActor("Ana Ruiz", ["PICKER"]);
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { claimedById: holder.userId });

    await expect(
      claim(db, picker, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.claimedByOther",
      params: { name: "Ana Ruiz" },
    });
  });

  it("names a holder who has no name yet by their email", async () => {
    const holder = await namedActor("", ["PICKER"]);
    const { email } = await db.user.findUniqueOrThrow({ where: { id: holder.userId } });
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { claimedById: holder.userId });

    await expect(
      claim(db, picker, { orderId: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({ params: { name: email } });
  });

  it("claims over an expired claim (SC 6)", async () => {
    const [holder, picker] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, {
      claimedById: holder.userId,
      claimedAt: minutesAgo(5),
    });

    const later = new Date(Date.now() + 30 * 60_000);
    const claimed = await claim(
      db,
      picker,
      { orderId: order.id, expectedVersion: 1 },
      { now: later },
    );

    expect(claimed.claimedById).toBe(picker.userId);
  });

  it("refuses a stale version", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { version: 4 });

    await expect(
      claim(db, picker, { orderId: order.id, expectedVersion: 3 }),
    ).rejects.toMatchObject({
      messageKey: "errors.workflow.stale",
    });
  });
});

describe("takeOver", () => {
  it("needs confirm: true (SC 6)", async () => {
    const [holder, picker] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, { claimedById: holder.userId });

    await expect(
      takeOver(db, picker, { orderId: order.id, expectedVersion: 1, confirm: false }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.workflow.takeOverConfirm" });
  });

  it("takes a live claim and audits the previous holder", async () => {
    const [holder, picker] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, { claimedById: holder.userId });

    const taken = await takeOver(db, picker, {
      orderId: order.id,
      expectedVersion: 1,
      confirm: true,
    });

    expect(taken).toMatchObject({ claimedById: picker.userId, version: 2 });
    expect(await db.auditEvent.findMany({ where: { entityId: order.id } })).toMatchObject([
      {
        action: "order.takeOver",
        before: { claimedById: holder.userId },
        after: { claimedById: picker.userId },
      },
    ]);
  });

  it("needs the permission for the order's stage", async () => {
    const [holder, picker] = [await createActor(db, ["QA"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, { status: "QA", claimedById: holder.userId });

    await expect(
      takeOver(db, picker, { orderId: order.id, expectedVersion: 1, confirm: true }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("release", () => {
  it("lets the holder release", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { claimedById: picker.userId });

    const released = await release(db, picker, { orderId: order.id });

    expect(released).toMatchObject({ claimedById: null, claimedAt: null, version: 2 });
    expect(await db.auditEvent.findMany({ where: { entityId: order.id } })).toMatchObject([
      { action: "order.release", before: { claimedById: picker.userId } },
    ]);
  });

  it("lets an Admin release someone else's claim", async () => {
    const [holder, admin] = [await createActor(db, ["PICKER"]), await createActor(db, ["ADMIN"])];
    const { order } = await createOrder(db, { claimedById: holder.userId });

    await expect(release(db, admin, { orderId: order.id })).resolves.toMatchObject({
      claimedById: null,
    });
  });

  it("refuses anyone else", async () => {
    const [holder, picker] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order } = await createOrder(db, { claimedById: holder.userId });

    await expect(release(db, picker, { orderId: order.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("does nothing when there is no live claim", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    await expect(release(db, picker, { orderId: order.id })).resolves.toEqual(order);
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("claimMany", () => {
  it("claims every order", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const a = await createOrder(db);
    const b = await createOrder(db, { status: "PICKING", version: 3 });

    const claimed = await claimMany(db, picker, {
      orders: [
        { id: b.order.id, expectedVersion: 3 },
        { id: a.order.id, expectedVersion: 1 },
      ],
    });

    expect(claimed.map((o) => [o.id, o.claimedById])).toEqual([
      [b.order.id, picker.userId],
      [a.order.id, picker.userId],
    ]);
  });

  it("claims none when one fails, and reports each failure (SC 6)", async () => {
    const holder = await namedActor("Ana Ruiz", ["PICKER"]);
    const picker = await createActor(db, ["PICKER"]);
    const free = await createOrder(db);
    const taken = await createOrder(db, { claimedById: holder.userId });
    const stale = await createOrder(db, { version: 2 });

    await expect(
      claimMany(db, picker, {
        orders: [
          { id: free.order.id, expectedVersion: 1 },
          { id: taken.order.id, expectedVersion: 1 },
          { id: stale.order.id, expectedVersion: 1 },
        ],
      }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.claimManyFailed",
      failures: [
        {
          orderId: taken.order.id,
          messageKey: "errors.workflow.claimedByOther",
          params: { name: "Ana Ruiz" },
        },
        { orderId: stale.order.id, messageKey: "errors.workflow.stale", params: {} },
      ],
    });

    expect(
      (await db.order.findUniqueOrThrow({ where: { id: free.order.id } })).claimedById,
    ).toBeNull();
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("reports a missing order", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const missing = "00000000-0000-7000-8000-000000000000";

    await expect(
      claimMany(db, picker, { orders: [{ id: missing, expectedVersion: 1 }] }),
    ).rejects.toMatchObject({ failures: [{ orderId: missing, messageKey: "errors.notFound" }] });
  });

  it("takes at most 50 orders", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const orders = Array.from({ length: 51 }, (_, i) => ({
      id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      expectedVersion: 1,
    }));

    await expect(claimMany(db, picker, { orders })).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});

describe("touchClaim", () => {
  it("refreshes the holder's live claim without bumping the version", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, {
      claimedById: picker.userId,
      claimedAt: minutesAgo(20),
    });

    const touched = await db.$transaction((tx) => touchClaim(tx, picker, order.id));

    expect(touched).toBe(true);
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.version).toBe(1);
    expect(after.claimedAt?.getTime()).toBeGreaterThan(order.claimedAt?.getTime() ?? 0);
  });

  it("leaves someone else's claim and an expired claim alone", async () => {
    const [holder, picker] = [await createActor(db, ["PICKER"]), await createActor(db, ["PICKER"])];
    const { order: other } = await createOrder(db, { claimedById: holder.userId });
    const { order: expired } = await createOrder(db, {
      claimedById: picker.userId,
      claimedAt: minutesAgo(45),
    });

    expect(await db.$transaction((tx) => touchClaim(tx, picker, other.id))).toBe(false);
    expect(await db.$transaction((tx) => touchClaim(tx, picker, expired.id))).toBe(false);
  });
});
