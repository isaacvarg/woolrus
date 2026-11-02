import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { pushToWoo } from "./woo-push";
import { pushErrors, retryWooPush } from "./woo-push-errors";

// The Push errors list and its Retry (SPEC-shipping "Push errors view", FR-SHIP-10, criterion 7).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'woo.push'`);
});

const now = new Date("2026-11-02T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

async function pushed(
  data: { wooPushStatus: "PENDING" | "FAILED" | "SUCCEEDED"; wooPushError?: string; at?: Date },
  wooOrderId?: number,
) {
  const { order } = await createOrder(db, { status: "COMPLETED" });
  await db.order.update({
    where: { id: order.id },
    data: {
      wooPushStatus: data.wooPushStatus,
      wooPushError: data.wooPushError ?? null,
      wooPushAttempts: 3,
      ...(wooOrderId ? { wooOrderId } : {}),
    },
  });
  // `updatedAt` is managed by Prisma; set it with raw SQL.
  await db.$executeRaw`UPDATE orders SET updated_at = ${data.at ?? now} WHERE id = ${order.id}`;
  return order;
}

describe("pushErrors", () => {
  it("lists failed orders and pending ones older than 15 minutes, not fresh or succeeded", async () => {
    const failed = await pushed({
      wooPushStatus: "FAILED",
      wooPushError: "errors.sync.unauthorized",
      at: minutesAgo(1),
    });
    const stale = await pushed({ wooPushStatus: "PENDING", at: minutesAgo(20) });
    await pushed({ wooPushStatus: "PENDING", at: minutesAgo(5) });
    await pushed({ wooPushStatus: "SUCCEEDED", at: minutesAgo(60) });
    const admin = await createActor(db, ["ADMIN"]);

    const { rows } = await pushErrors(db, admin, { now });

    expect(rows.map((r) => r.orderId).sort()).toEqual([failed.id, stale.id].sort());
    expect(rows.find((r) => r.orderId === failed.id)).toMatchObject({
      status: "FAILED",
      error: "errors.sync.unauthorized",
      attempts: 3,
      orderNumber: failed.number,
    });
  });

  it("is for settings.manage only", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    await expect(pushErrors(db, shipper, { now })).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("retryWooPush", () => {
  it("sets failed orders pending and re-queues; the job then succeeds against the store", async () => {
    const store = new FakeStoreAdapter();
    const woo = store.addOrder();
    const order = await pushed(
      { wooPushStatus: "FAILED", wooPushError: "errors.sync.unreachable" },
      woo.id,
    );
    const admin = await createActor(db, ["ADMIN"]);

    const result = await retryWooPush(db, admin, { orderIds: [order.id] }, { now });

    expect(result).toEqual({ retried: 1 });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      wooPushStatus: "PENDING",
      wooPushError: null,
    });
    const jobs = await db.$queryRawUnsafe<{ data: { orderId: string } }[]>(
      "SELECT data FROM pgboss.job WHERE name = 'woo.push'",
    );
    expect(jobs.map((j) => j.data.orderId)).toContain(order.id);

    await expect(pushToWoo(db, store, { orderId: order.id })).resolves.toEqual({
      outcome: "succeeded",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).wooPushStatus).toBe(
      "SUCCEEDED",
    );
  });

  it("leaves orders that aren't in error alone and audits the retry", async () => {
    const ok = await pushed({ wooPushStatus: "SUCCEEDED" });
    const failed = await pushed({ wooPushStatus: "FAILED", wooPushError: "errors.internal" });
    const admin = await createActor(db, ["ADMIN"]);

    const result = await retryWooPush(db, admin, { orderIds: [ok.id, failed.id] }, { now });

    expect(result).toEqual({ retried: 1 });
    expect((await db.order.findUniqueOrThrow({ where: { id: ok.id } })).wooPushStatus).toBe(
      "SUCCEEDED",
    );
    expect(
      await db.auditEvent.count({ where: { action: "woo.push.retry", entityId: failed.id } }),
    ).toBe(1);
  });

  it("is for settings.manage only", async () => {
    const failed = await pushed({ wooPushStatus: "FAILED" });
    const shipper = await createActor(db, ["SHIPPER"]);
    await expect(
      retryWooPush(db, shipper, { orderIds: [failed.id] }, { now }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});
