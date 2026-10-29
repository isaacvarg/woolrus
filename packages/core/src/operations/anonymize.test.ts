import { type Db, Prisma, type ReturnStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { lockWooOrder } from "../sync/order-lock";
import { anonymizeOrder, purgePii } from "./anonymize";

const db: Db = testDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-28T09:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

beforeEach(async () => {
  await resetDb(db);
  await db.settings.create({ data: { id: 1, piiRetentionDays: 30 } });
});

const personal = {
  name: "Ann Buyer",
  first_name: "Ann",
  last_name: "Buyer",
  address_1: "1 Main St",
  address_2: "Apt 2",
  city: "Austin",
  state: "TX",
  postcode: "78701",
  country: "US",
  phone: "555-0100",
  email: "ann@example.test",
};

/** An order with everything the anonymizer touches, `daysAgo` past its finish. */
async function finished(status: "COMPLETED" | "CANCELLED", days: number) {
  const built = await createOrder(db, {
    status,
    packages: [{ items: [{ line: 0, quantity: 1 }], label: "ACTIVE" }],
  });
  const at = daysAgo(days);
  const order = await db.order.update({
    where: { id: built.order.id },
    data: {
      ...(status === "COMPLETED" ? { completedAt: at } : {}),
      statusChangedAt: at,
      customerName: "Ann Buyer",
      customerEmail: "ann@example.test",
      customerNote: "Leave at the back door",
      shippingAddress: personal,
      billingAddress: personal,
      shipTo: personal,
      shipToOriginal: personal,
      shipToMessages: [{ messageKey: "x", line: "1 Main St" }],
      externalChangeSummary: { shippingAddress: "1 Main St" },
      rawPayload: {
        id: 7,
        number: "7",
        status: "completed",
        currency: "USD",
        total: "25.00",
        date_created: "d",
        date_modified: "m",
        billing: personal,
      },
    },
  });
  const item = built.items[0];
  if (!item) throw new Error("no item");
  await db.orderItem.update({
    where: { id: item.id },
    data: {
      metaData: [{ key: "Gift message", value: "Dear Bob" }],
      attributes: [{ name: "Size", option: "L" }],
    },
  });
  const pkg = built.packages[0];
  if (!pkg) throw new Error("no package");
  const label = await db.shippingLabel.findFirstOrThrow({ where: { packageId: pkg.id } });
  await db.shippingLabel.update({
    where: { id: label.id },
    data: { storageKey: "labels/x.pdf", trackingNumber: "TRK1", costCents: 612 },
  });
  await db.note.create({ data: { orderId: order.id, content: "Packed with care" } });
  const audit = (entityType: string, entityId: string) =>
    db.auditEvent.create({
      data: {
        entityType,
        entityId,
        action: "edit",
        before: { customerEmail: "ann@example.test", status: "A" },
        after: { shipTo: personal, status: "B", nested: { email: "x@y.z", keep: 1 } },
      },
    });
  await audit("Order", order.id);
  await audit("Package", pkg.id);
  await audit("ShippingLabel", label.id);
  return { order, pkg, label };
}

const reload = (id: string) =>
  db.order.findUniqueOrThrow({
    where: { id },
    include: { items: true, packages: { include: { labels: true } }, notes: true },
  });

describe("purgePii (SPEC-operations 'PII anonymization')", () => {
  it("anonymizes finished orders past the period, as the spec's table says, and nothing else", async () => {
    const done = await finished("COMPLETED", 31);
    const cancelled = await finished("CANCELLED", 31);
    const recent = await finished("COMPLETED", 29);
    const held = await finished("COMPLETED", 31);
    await db.order.update({
      where: { id: held.order.id },
      data: { status: "ON_HOLD", heldFromStatus: "PICKING" },
    });
    const qa = await finished("COMPLETED", 31);
    await db.order.update({ where: { id: qa.order.id }, data: { status: "QA" } });
    const returning = await finished("COMPLETED", 31);
    await db.returnRequest.create({
      data: { orderId: returning.order.id, rmaNumber: "RMA-1", reason: "damaged" },
    });

    const result = await purgePii(db, { now });
    expect(result.orders).toBe(2);

    for (const { order } of [done, cancelled]) {
      const o = await reload(order.id);
      expect(o.piiRedactedAt).toEqual(now);
      expect(o).toMatchObject({
        customerName: "",
        customerEmail: null,
        customerNote: null,
        externalChangeSummary: null,
        shipToMessages: [],
      });
      const reduced = { state: "TX", postcode: "78701", country: "US" };
      expect(o.shippingAddress).toEqual(reduced);
      expect(o.billingAddress).toEqual(reduced);
      expect(o.shipTo).toEqual(reduced);
      expect(o.shipToOriginal).toEqual(reduced);
      expect(o.rawPayload).toEqual({
        id: 7,
        number: "7",
        status: "completed",
        currency: "USD",
        total: "25.00",
        date_created: "d",
        date_modified: "m",
        redacted: true,
      });
      expect(o.items[0]?.metaData).toEqual([]);
      expect(o.items[0]?.attributes).toEqual([{ name: "Size", option: "L" }]);
      // Kept: label rows and files, notes, packages, costs, tracking.
      expect(o.packages).toHaveLength(1);
      expect(o.packages[0]?.labels[0]).toMatchObject({
        storageKey: "labels/x.pdf",
        trackingNumber: "TRK1",
        costCents: 612,
      });
      expect(o.notes.map((n) => n.content)).toEqual(["Packed with care"]);
      expect(o.totalCents).toBe(2500);

      const events = await db.auditEvent.findMany({
        where: {
          entityId: {
            in: [
              order.id,
              ...o.packages.map((p) => p.id),
              ...o.packages.flatMap((p) => p.labels.map((l) => l.id)),
            ],
          },
          action: "edit",
        },
      });
      expect(events).toHaveLength(3);
      for (const e of events) {
        expect(e.before).toEqual({ customerEmail: "[redacted]", status: "A" });
        expect(e.after).toEqual({
          shipTo: "[redacted]",
          status: "B",
          nested: { email: "[redacted]", keep: 1 },
        });
      }
      const marker = await db.auditEvent.findMany({
        where: { entityId: order.id, action: "pii.anonymize" },
      });
      expect(marker).toHaveLength(1);
      expect(marker[0]).toMatchObject({
        entityType: "Order",
        actorId: null,
        before: null,
        after: null,
      });
    }

    for (const { order } of [recent, held, qa, returning]) {
      const o = await reload(order.id);
      expect(o.piiRedactedAt).toBeNull();
      expect(o.customerName).toBe("Ann Buyer");
    }

    // Criterion 9: a second run changes nothing.
    const again = await purgePii(db, { now });
    expect(again.orders).toBe(0);
    expect(await db.auditEvent.count({ where: { action: "pii.anonymize" } })).toBe(2);
  });

  it("keeps null address columns null", async () => {
    const { order } = await finished("COMPLETED", 40);
    await db.order.update({
      where: { id: order.id },
      data: { shipTo: Prisma.DbNull, shipToOriginal: Prisma.DbNull },
    });
    await purgePii(db, { now });
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.shipTo).toBeNull();
    expect(o.shipToOriginal).toBeNull();
  });

  it("redacts processed webhook payloads older than the period, and deletes idempotency records older than 7 days", async () => {
    const hook = (deliveryId: string, receivedAt: Date, processedAt: Date | null) =>
      db.inboundWebhook.create({
        data: {
          source: "woocommerce",
          deliveryId,
          topic: "order.updated",
          payload: { id: 1, billing: personal },
          receivedAt,
          processedAt,
        },
      });
    const old = await hook("a", daysAgo(31), daysAgo(31));
    const unprocessed = await hook("b", daysAgo(31), null);
    const fresh = await hook("c", daysAgo(5), daysAgo(5));
    const key = (k: string, createdAt: Date) =>
      db.idempotentRequest.create({
        data: { key: k, procedure: "p", response: { name: "Ann" }, createdAt },
      });
    await key("old", daysAgo(8));
    await key("new", daysAgo(6));

    const result = await purgePii(db, { now });
    expect(result).toMatchObject({ webhooks: 2, idempotency: 1 });
    expect((await db.inboundWebhook.findUniqueOrThrow({ where: { id: old.id } })).payload).toEqual({
      redacted: true,
    });
    // Never processed, but it arrived over 30 days ago: it still holds the customer's data.
    expect(
      (await db.inboundWebhook.findUniqueOrThrow({ where: { id: unprocessed.id } })).payload,
    ).toEqual({ redacted: true });
    expect(
      (await db.inboundWebhook.findUniqueOrThrow({ where: { id: fresh.id } })).payload,
    ).toMatchObject({ id: 1 });
    expect((await db.idempotentRequest.findMany()).map((r) => r.key)).toEqual(["new"]);
  });

  it("with no retention period anonymizes nothing but still deletes old idempotency records (criterion 10)", async () => {
    await db.settings.update({ where: { id: 1 }, data: { piiRetentionDays: null } });
    const { order } = await finished("COMPLETED", 3000);
    const hook = await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "z",
        topic: "order.updated",
        payload: { id: 1 },
        receivedAt: daysAgo(3000),
        processedAt: daysAgo(3000),
      },
    });
    await db.idempotentRequest.create({
      data: { key: "old", procedure: "p", response: {}, createdAt: daysAgo(8) },
    });

    const result = await purgePii(db, { now });
    expect(result).toEqual({ orders: 0, webhooks: 0, idempotency: 1, failed: 0 });
    expect((await reload(order.id)).piiRedactedAt).toBeNull();
    expect((await db.inboundWebhook.findUniqueOrThrow({ where: { id: hook.id } })).payload).toEqual(
      { id: 1 },
    );
    expect(await db.idempotentRequest.count()).toBe(0);
  });

  it("dry run counts and changes nothing (criterion 13)", async () => {
    const { order } = await finished("COMPLETED", 31);
    await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "d",
        topic: "order.updated",
        payload: { id: 1 },
        receivedAt: daysAgo(31),
        processedAt: daysAgo(31),
      },
    });
    await db.idempotentRequest.create({
      data: { key: "old", procedure: "p", response: {}, createdAt: daysAgo(8) },
    });

    expect(await purgePii(db, { now, dryRun: true })).toEqual({
      orders: 1,
      webhooks: 1,
      idempotency: 1,
      failed: 0,
    });
    expect((await reload(order.id)).piiRedactedAt).toBeNull();
    expect(await db.idempotentRequest.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "pii.anonymize" } })).toBe(0);
  });

  it("works through more than one batch of 200", async () => {
    const { order } = await finished("COMPLETED", 31);
    const rows = Array.from({ length: 205 }, (_, i) => ({
      ...order,
      id: undefined,
      wooOrderId: 9_000_000 + i,
      number: String(9_000_000 + i),
    }));
    await db.order.createMany({ data: rows.map(({ id: _id, ...r }) => r as never) });
    const result = await purgePii(db, { now });
    expect(result.orders).toBe(206);
    expect(await db.order.count({ where: { piiRedactedAt: null } })).toBe(0);
  }, 60_000);
});

describe("purgePii edge cases", () => {
  it("keeps an order at exactly the period and anonymizes one a millisecond past it", async () => {
    const exact = await finished("COMPLETED", 0);
    const past = await finished("COMPLETED", 0);
    const cancelled = await finished("CANCELLED", 29);
    const cutoff = daysAgo(30);
    await db.order.update({ where: { id: exact.order.id }, data: { completedAt: cutoff } });
    await db.order.update({
      where: { id: past.order.id },
      data: { completedAt: new Date(cutoff.getTime() - 1) },
    });
    const result = await purgePii(db, { now });
    expect(result.orders).toBe(1);
    expect((await reload(exact.order.id)).piiRedactedAt).toBeNull();
    expect((await reload(past.order.id)).piiRedactedAt).not.toBeNull();
    expect((await reload(cancelled.order.id)).piiRedactedAt).toBeNull();
  });

  it("never anonymizes a completed order without a completion time", async () => {
    const { order } = await finished("COMPLETED", 90);
    await db.order.update({ where: { id: order.id }, data: { completedAt: null } });
    expect((await purgePii(db, { now })).orders).toBe(0);
  });

  it.each([
    ["REQUESTED", true],
    ["APPROVED", true],
    ["LABEL_SENT", true],
    ["RECEIVED", true],
    ["INSPECTED", true],
    ["CLOSED", false],
    ["REJECTED", false],
  ] as [ReturnStatus, boolean][])(
    "a %s return blocks anonymization: %s",
    async (status, blocks) => {
      const { order } = await finished("COMPLETED", 40);
      await db.returnRequest.create({
        data: { orderId: order.id, rmaNumber: `RMA-${status}`, reason: "x", status },
      });
      expect((await purgePii(db, { now })).orders).toBe(blocks ? 0 : 1);
    },
  );

  it("two overlapping runs anonymize an order once, with one audit marker", async () => {
    const { order } = await finished("COMPLETED", 40);
    const runs = await Promise.all([purgePii(db, { now }), purgePii(db, { now })]);
    expect(runs.reduce((sum, r) => sum + r.orders, 0)).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "pii.anonymize" } })).toBe(1);
    expect((await reload(order.id)).piiRedactedAt).toEqual(now);
  });

  it("anonymizeOrder on an already anonymized order does nothing", async () => {
    const { order } = await finished("COMPLETED", 40);
    expect(await db.$transaction((tx) => anonymizeOrder(tx, order.id, now))).toBe(true);
    expect(await db.$transaction((tx) => anonymizeOrder(tx, order.id, new Date()))).toBe(false);
    expect(await db.auditEvent.count({ where: { action: "pii.anonymize" } })).toBe(1);
    expect((await reload(order.id)).piiRedactedAt).toEqual(now);
  });

  it("one order failing leaves the others anonymized and is counted", async () => {
    const first = await finished("COMPLETED", 40);
    const second = await finished("COMPLETED", 40);
    const third = await finished("COMPLETED", 40);
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "$transaction") {
          return (fn: never, options: never) =>
            ++calls === 1
              ? Promise.reject(new Error("boom"))
              : (value as typeof db.$transaction).call(target, fn, options);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await purgePii(flaky, { now });
    expect(result).toMatchObject({ orders: 2, failed: 1 });
    const done = await db.order.findMany({
      where: { piiRedactedAt: { not: null } },
      select: { id: true },
    });
    expect(done).toHaveLength(2);
    expect([first, second, third].length).toBe(3);
    // The next run picks the failed one up.
    expect((await purgePii(db, { now })).orders).toBe(1);
  });

  it("waits for the store import's lock on the order before anonymizing it", async () => {
    const { order } = await finished("COMPLETED", 40);
    const wooOrderId = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).wooOrderId;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const importing = db.$transaction(
      async (tx) => {
        await lockWooOrder(tx, wooOrderId);
        locked();
        await hold;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const purge = purgePii(db, { now });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await reload(order.id)).piiRedactedAt).toBeNull();
    release();
    await importing;
    expect((await purge).orders).toBe(1);
    expect((await reload(order.id)).piiRedactedAt).toEqual(now);
  });

  it("turns an unusable required address into {} instead of failing", async () => {
    const { order } = await finished("COMPLETED", 40);
    await db.order.update({
      where: { id: order.id },
      data: { shippingAddress: [], billingAddress: "text" },
    });
    expect(await purgePii(db, { now })).toMatchObject({ orders: 1, failed: 0 });
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.shippingAddress).toEqual({});
    expect(o.billingAddress).toEqual({});
  });

  it("redacting webhooks twice changes nothing the second time", async () => {
    await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "d",
        topic: "order.updated",
        payload: { id: 1, billing: personal },
        receivedAt: daysAgo(40),
        processedAt: daysAgo(40),
      },
    });
    expect((await purgePii(db, { now })).webhooks).toBe(1);
    expect((await purgePii(db, { now })).webhooks).toBe(0);
  });
});
