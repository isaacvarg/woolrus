import type { Db } from "@woolrus/db";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { ORDER_CHANGED_CHANNEL } from "./notify";
import { beginPicking, transition } from "./service";

const db: Db = testDb();
let listener: pg.Client;
let received: unknown[];

afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  received = [];
  listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await listener.connect();
  listener.on("notification", (msg) => received.push(JSON.parse(msg.payload ?? "null")));
  await listener.query(`LISTEN ${ORDER_CHANGED_CHANNEL}`);
});
afterEach(() => listener.end());

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe("order_changed notifications", () => {
  it("delivers the order id and new status, and nothing else, on commit", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, { customerName: "Jane Private" });

    await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });
    await settle();

    expect(received).toEqual([{ id: order.id, status: "PICKING" }]);
  });

  it("sends nothing when the caller's transaction rolls back", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    await expect(
      db.$transaction(async (tx) => {
        await transition(tx, picker, {
          orderId: order.id,
          expectedVersion: 1,
          to: "PICKING",
          kind: "beginPicking",
        });
        throw new Error("stage module failed after the move");
      }),
    ).rejects.toThrow("stage module failed");
    await settle();

    expect(received).toEqual([]);
  });
});
