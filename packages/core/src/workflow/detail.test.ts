import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { orderMutations, toOrderDetails } from "./detail";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("toOrderDetails", () => {
  it("shows a live claim with the holder's name", async () => {
    const picker = await createActor(db, ["PICKER"]);
    await db.user.update({ where: { id: picker.userId }, data: { name: "Ana" } });
    const at = minutesAgo(5);
    const { order } = await createOrder(db, {
      status: "PICKING",
      claimedById: picker.userId,
      claimedAt: at,
    });

    const [detail] = await toOrderDetails(db, [order]);

    expect(detail).toMatchObject({
      id: order.id,
      status: "PICKING",
      claim: { userId: picker.userId, userName: "Ana", at },
      externalChange: false,
      version: 1,
    });
  });

  it("hides an expired claim", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db, {
      status: "PICKING",
      claimedById: picker.userId,
      claimedAt: minutesAgo(31),
    });

    expect((await toOrderDetails(db, [order]))[0]?.claim).toBeNull();
  });
});

describe("allVoided", () => {
  it("is true only when every line is voided down to nothing, and clears on undo", async () => {
    const { order, items } = await createOrder(db, {
      status: "PICKING",
      lines: [
        { quantity: 2, voids: [{ quantity: 2 }] },
        { quantity: 1, voids: [{ quantity: 1 }] },
      ],
    });
    const open = await createOrder(db, { status: "PICKING", lines: [{ quantity: 1 }] });
    const empty = await createOrder(db, { status: "PICKING", lines: [] });

    const [voided, notVoided, none] = await toOrderDetails(db, [order, open.order, empty.order]);
    expect(voided?.allVoided).toBe(true);
    expect(notVoided?.allVoided).toBe(false);
    expect(none?.allVoided).toBe(false);

    await db.itemVoid.updateMany({
      where: { orderItemId: items[0]?.id },
      data: { undoneAt: new Date() },
    });
    const [after] = await toOrderDetails(db, [order]);
    expect(after?.allVoided).toBe(false);
  });
});

describe("orderMutations", () => {
  it("takes the API's `id` and returns the order detail", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);

    const detail = await orderMutations.beginPicking(db, picker, {
      id: order.id,
      expectedVersion: 1,
    });

    expect(detail).toMatchObject({
      id: order.id,
      status: "PICKING",
      version: 2,
      claim: { userId: picker.userId },
    });
  });

  it("passes a refused gate's unmet list through", async () => {
    const packer = await createActor(db, ["PACKER"]);
    const { order } = await createOrder(db, {
      status: "PACKING",
      claimedById: packer.userId,
      lines: [{ name: "Lip Balm", quantity: 2, pickStatus: "PICKED", pickedQuantity: 2 }],
    });

    await expect(
      orderMutations.completePacking(db, packer, { id: order.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.gateFailed",
      unmet: [
        {
          messageKey: "errors.workflow.gate.lineUnderPacked",
          params: { line: "Lip Balm", packed: 0, expected: 2 },
        },
      ],
    });
  });

  it("returns every claimed order from claimMany", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const [a, b] = [await createOrder(db), await createOrder(db)];

    const details = await orderMutations.claimMany(db, picker, {
      orders: [
        { id: a.order.id, expectedVersion: 1 },
        { id: b.order.id, expectedVersion: 1 },
      ],
    });

    expect(details.map((d) => [d.id, d.claim?.userId])).toEqual([
      [a.order.id, picker.userId],
      [b.order.id, picker.userId],
    ]);
  });
});
