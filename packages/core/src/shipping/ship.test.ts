import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { AppError } from "../errors";
import { shipOrders } from "./ship";

// Ship from Ready (SPEC-shipping "Ship", success criterion 2).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'woo.push'`);
});

const key = () => crypto.randomUUID();
const jobs = () =>
  db.$queryRawUnsafe<{ data: { orderId: string } }[]>(
    `SELECT data FROM pgboss.job WHERE name = 'woo.push'`,
  );

const readyOrder = (printCount = 1, label: "ACTIVE" | "VOIDED" | "NONE" = "ACTIVE") =>
  createOrder(db, {
    status: "READY",
    packages: [label === "NONE" ? {} : { label }],
  }).then(async (built) => {
    await db.shippingLabel.updateMany({
      where: { package: { orderId: built.order.id } },
      data: { printCount },
    });
    return built.order;
  });

describe("shipOrders", () => {
  it("completes Ready orders, names the shipper in the stage event and enqueues woo.push", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const a = await readyOrder();
    const b = await readyOrder();
    const { results } = await shipOrders(db, shipper, {
      orderIds: [a.id, b.id],
      confirmUnprinted: false,
      idempotencyKey: key(),
    });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const after = await db.order.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({
      status: "COMPLETED",
      wooPushStatus: "PENDING",
      wooPushAttempts: 0,
      wooPushError: null,
    });
    expect(after.completedAt).not.toBeNull();
    const event = await db.orderStageEvent.findFirstOrThrow({
      where: { orderId: a.id, toStatus: "COMPLETED" },
    });
    expect(event.actorId).toBe(shipper.userId);
    expect((await jobs()).map((j) => j.data.orderId).sort()).toEqual([a.id, b.id].sort());
  });

  it("fails a non-Ready order or one without an active label on its own, leaving no job", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const good = await readyOrder();
    const noLabel = await readyOrder(0, "NONE");
    const voided = await readyOrder(0, "VOIDED");
    const pending = (await createOrder(db, { status: "PENDING" })).order;
    const { results } = await shipOrders(db, shipper, {
      orderIds: [noLabel.id, good.id, voided.id, pending.id],
      confirmUnprinted: true,
      idempotencyKey: key(),
    });
    expect(results.map((r) => r.ok)).toEqual([false, true, false, false]);
    expect(results[0]).toMatchObject({ orderNumber: noLabel.number });
    for (const o of [noLabel, voided, pending]) {
      const row = await db.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(row.wooPushStatus).toBe("NOT_NEEDED");
      expect(row.status).not.toBe("COMPLETED");
    }
    expect((await jobs()).map((j) => j.data.orderId)).toEqual([good.id]);
  });

  it("asks for confirmation when a label was never printed, writing nothing without it", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const printed = await readyOrder(2);
    const unprinted = await readyOrder(0);
    const input = { orderIds: [printed.id, unprinted.id], idempotencyKey: key() };
    const err = await shipOrders(db, shipper, { ...input, confirmUnprinted: false }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.shipping.unprintedLabels",
      params: { orderNumbers: unprinted.number },
    });
    expect(await db.order.count({ where: { status: "COMPLETED" } })).toBe(0);
    expect(await jobs()).toHaveLength(0);

    const { results } = await shipOrders(db, shipper, { ...input, confirmUnprinted: true });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("replays the stored results without shipping twice", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const a = await readyOrder();
    const input = { orderIds: [a.id], confirmUnprinted: false, idempotencyKey: key() };
    const first = await shipOrders(db, shipper, input);
    const second = await shipOrders(db, shipper, input);
    expect(second).toEqual(first);
    expect(await jobs()).toHaveLength(1);
    expect(
      await db.orderStageEvent.count({ where: { orderId: a.id, toStatus: "COMPLETED" } }),
    ).toBe(1);
  });

  it("allows Shipper and Admin, forbids QA", async () => {
    const a = await readyOrder();
    const qa = await createActor(db, ["QA"]);
    await expect(
      shipOrders(db, qa, { orderIds: [a.id], confirmUnprinted: true, idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    const admin = await createActor(db, ["ADMIN"]);
    const { results } = await shipOrders(db, admin, {
      orderIds: [a.id],
      confirmUnprinted: false,
      idempotencyKey: key(),
    });
    expect(results[0]?.ok).toBe(true);
  });
});
