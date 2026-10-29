import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { verifiedQaOrder } from "../../test/qa-fixtures";
import { completeQaWithLabels } from "./complete";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

const jobs = () =>
  db.$queryRawUnsafe<{ data: { orderId: string; requestedById: string } }[]>(
    `SELECT data FROM pgboss.job WHERE name = 'labels.purchase'`,
  );
const labels = () => db.shippingLabel.findMany({ orderBy: { createdAt: "asc" } });

async function ready(count = 2) {
  const built = await verifiedQaOrder(db, count);
  const request = (actor = built.qa) =>
    completeQaWithLabels(db, actor, {
      orderId: built.order.id,
      expectedVersion: built.order.version,
    });
  return { ...built, request };
}

describe("completeQaWithLabels", () => {
  it("records a PURCHASING label per package and queues one job in one transaction", async () => {
    const { qa, order, packages, request } = await ready(2);
    const before = new Date(Date.now() - 60_000);
    await db.order.update({ where: { id: order.id }, data: { claimedAt: before } });
    // the claim is still live (default expiry is far longer than a minute)

    const updated = await request();

    expect(updated.status).toBe("QA");
    expect(updated.version).toBe(order.version + 1);
    expect(updated.claimedAt?.getTime()).toBeGreaterThan(before.getTime());
    const rows = await labels();
    expect(rows.map((l) => l.packageId).sort()).toEqual(packages.map((p) => p.id).sort());
    for (const l of rows) {
      expect(l).toMatchObject({
        status: "PURCHASING",
        provider: "SHIPSTATION",
        purchasedById: qa.userId,
        quotedAmountCents: 450,
        carrierCode: "demo_ground",
      });
      expect(l.carrierId).not.toBeNull();
      expect(l.serviceId).not.toBeNull();
      expect(l.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await jobs()).toMatchObject([{ data: { orderId: order.id, requestedById: qa.userId } }]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: "labels.purchaseRequested" },
    });
    expect(audit.actorId).toBe(qa.userId);
  });

  it("two concurrent requests buy once", async () => {
    const { request, packages } = await ready(2);
    const results = await Promise.allSettled([request(), request()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await labels()).toHaveLength(packages.length);
    expect(await jobs()).toHaveLength(1);
  });

  it("only buys the packages without a live label", async () => {
    const { request, packages } = await ready(2);
    const [first, second] = packages;
    await db.shippingLabel.create({
      data: {
        packageId: first?.id,
        status: "PURCHASE_FAILED",
        provider: "SHIPSTATION",
        idempotencyKey: "old",
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        currency: "USD",
        error: "errors.shipping.notOffered",
      },
    });
    await db.shippingLabel.create({
      data: {
        packageId: second?.id,
        status: "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: "bought",
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        currency: "USD",
        storageKey: "labels/x.pdf",
      },
    });
    await request();
    const rows = await labels();
    expect(rows.filter((l) => l.packageId === first?.id)).toHaveLength(2);
    expect(rows.filter((l) => l.packageId === second?.id)).toHaveLength(1);
    expect(rows.filter((l) => l.status === "PURCHASING")).toHaveLength(1);
  });

  it("moves the order when every package already has a stored label, without a job", async () => {
    const { request, order, packages, qa } = await ready(1);
    await db.shippingLabel.create({
      data: {
        packageId: packages[0]?.id,
        status: "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: "bought",
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        currency: "USD",
        storageKey: "labels/x.pdf",
      },
    });
    // an expired rate doesn't matter once the label is bought
    await db.shippingRate.updateMany({ data: { expiresAt: new Date(0) } });
    const updated = await request();
    expect(updated.status).toBe("READY");
    expect(await jobs()).toHaveLength(0);
    const event = await db.orderStageEvent.findFirstOrThrow({
      where: { orderId: order.id, toStatus: "READY" },
    });
    expect(event.actorId).toBe(qa.userId);
  });

  describe("refuses, writing nothing, when", () => {
    const unmetKeys = async (promise: Promise<unknown>) => {
      const error = (await promise.catch((e: unknown) => e)) as {
        messageKey: string;
        unmet?: { messageKey: string }[];
      };
      expect(error.messageKey).toBe("errors.workflow.gateFailed");
      return error.unmet?.map((u) => u.messageKey);
    };
    const untouched = async () => {
      expect(await labels()).toHaveLength(0);
      expect(await jobs()).toHaveLength(0);
      expect(await db.auditEvent.count({ where: { action: "labels.purchaseRequested" } })).toBe(0);
    };

    it("a row is unverified", async () => {
      const { request } = await ready();
      await db.packageItem.updateMany({ data: { qaVerifiedAt: null, qaVerifiedQuantity: 0 } });
      expect(await unmetKeys(request())).toContain("errors.workflow.gate.packageNotVerified");
      await untouched();
    });

    it("a package has no selected rate", async () => {
      const { request } = await ready();
      await db.shippingRate.updateMany({ data: { selected: false } });
      expect(await unmetKeys(request())).toContain("errors.workflow.gate.packageNoRate");
      await untouched();
    });

    it("a selected rate has expired", async () => {
      const { request } = await ready();
      await db.shippingRate.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await unmetKeys(request())).toContain("errors.qa.packageRateExpired");
      await untouched();
    });

    it("the provider is off", async () => {
      const { request } = await ready();
      await db.shippingProviderAccount.updateMany({ data: { enabled: false } });
      expect(await unmetKeys(request())).toContain("errors.qa.packageProviderOff");
      await untouched();
    });

    it("an open critical issue exists", async () => {
      const { request, order } = await ready();
      await db.qualityIssue.create({
        data: {
          orderId: order.id,
          type: "DAMAGED_ITEM",
          severity: "CRITICAL",
          description: "Crushed jar",
          discoveredStage: "QA",
        },
      });
      expect(await unmetKeys(request())).toContain("errors.workflow.gate.criticalIssueOpen");
      await untouched();
    });

    it("a label is already purchasing", async () => {
      const { request, packages } = await ready();
      await db.shippingLabel.create({
        data: {
          packageId: packages[0]?.id,
          status: "PURCHASING",
          provider: "SHIPSTATION",
          idempotencyKey: "busy",
          carrierCode: "demo_ground",
          serviceCode: "demo_ground",
          currency: "USD",
        },
      });
      expect(await unmetKeys(request())).toContain("errors.qa.purchaseInProgress");
      expect(await jobs()).toHaveLength(0);
    });

    it("the version is stale, the claim is someone else's, or the order isn't in QA", async () => {
      const { order, qa } = await ready();
      await expect(
        completeQaWithLabels(db, qa, { orderId: order.id, expectedVersion: order.version + 5 }),
      ).rejects.toMatchObject({ messageKey: "errors.workflow.stale" });
      const other = await createActor(db, ["QA"]);
      await expect(
        completeQaWithLabels(db, other, { orderId: order.id, expectedVersion: order.version }),
      ).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });
      await db.order.update({ where: { id: order.id }, data: { status: "PACKING" } });
      await expect(
        completeQaWithLabels(db, qa, { orderId: order.id, expectedVersion: order.version }),
      ).rejects.toMatchObject({ messageKey: "errors.qa.notQa" });
      await untouched();
    });
  });

  it("is forbidden for a Shipper and a Packer", async () => {
    const { order } = await ready();
    for (const role of ["SHIPPER", "PACKER"] as const) {
      const actor = await createActor(db, [role]);
      await expect(
        completeQaWithLabels(db, actor, { orderId: order.id, expectedVersion: order.version }),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });
});
