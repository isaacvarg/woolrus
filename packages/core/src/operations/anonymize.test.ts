import { type Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { purgePii } from "./anonymize";

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
    expect(result).toMatchObject({ webhooks: 1, idempotency: 1 });
    expect((await db.inboundWebhook.findUniqueOrThrow({ where: { id: old.id } })).payload).toEqual({
      redacted: true,
    });
    expect(
      (await db.inboundWebhook.findUniqueOrThrow({ where: { id: unprocessed.id } })).payload,
    ).toMatchObject({ id: 1 });
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
    expect(result).toEqual({ orders: 0, webhooks: 0, idempotency: 1 });
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
