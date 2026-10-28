import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { demoRate, fakeProvider, purchaseCalls, verifiedQaOrder } from "../../test/qa-fixtures";
import { ShippingError } from "../adapters/shipping/errors";
import { createMemoryStorage } from "../adapters/storage/memory";
import { completeQaWithLabels } from "./complete";
import { purchaseLabels } from "./purchase";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

async function requested(count = 2) {
  const built = await verifiedQaOrder(db, count);
  const provider = fakeProvider();
  const storage = createMemoryStorage();
  const payload = { orderId: built.order.id, requestedById: built.qa.userId };
  const request = () =>
    completeQaWithLabels(db, built.qa, {
      orderId: built.order.id,
      expectedVersion: built.order.version,
    });
  await request();
  const run = () => purchaseLabels(db, { providers: [provider], storage }, payload);
  return { ...built, provider, storage, payload, run };
}

const labels = () => db.shippingLabel.findMany({ orderBy: { createdAt: "asc" } });
const status = async (orderId: string) =>
  (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;

describe("purchaseLabels", () => {
  it("buys every label, stores tracking, cost and the PDF, and moves the order to Ready as the requester", async () => {
    const { run, order, qa, storage, provider } = await requested(3);

    await run();

    const rows = await labels();
    expect(rows).toHaveLength(3);
    for (const l of rows) {
      expect(l.status).toBe("ACTIVE");
      expect(l.trackingNumber).toMatch(/^FAKE/);
      expect(l.costCents).toBe(450);
      expect(l.quotedAmountCents).toBe(450);
      expect(l.purchaseAttemptedAt).not.toBeNull();
      expect(l.purchasedAt).not.toBeNull();
      expect(l.storageKey).toBe(`labels/${l.id}.pdf`);
    }
    expect(storage.keys()).toEqual(rows.map((l) => `labels/${l.id}.pdf`).sort());
    expect(purchaseCalls(provider)).toBe(3);
    expect(await status(order.id)).toBe("READY");
    const event = await db.orderStageEvent.findFirstOrThrow({
      where: { orderId: order.id, toStatus: "READY" },
    });
    expect(event.actorId).toBe(qa.userId);
    const audits = await db.auditEvent.findMany({ where: { action: "label.purchase" } });
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actorId === qa.userId)).toBe(true);
  });

  it("keeps the bought labels when one is refused, fails that one without retry, and leaves the order in QA", async () => {
    const { run, order, provider, packages } = await requested(3);
    // refuse only the second package's label
    const real = provider.purchaseLabel.bind(provider);
    const failing = (await labels()).find((l) => l.packageId === packages[1]?.id);
    vi.spyOn(provider, "purchaseLabel").mockImplementation(async (input) => {
      if (input.idempotencyKey === failing?.idempotencyKey) {
        throw new ShippingError("notOffered", "purchaseLabel 422");
      }
      return real(input);
    });

    await run(); // permanent refusals don't throw

    const rows = await labels();
    expect(rows.filter((l) => l.status === "ACTIVE")).toHaveLength(2);
    const failed = rows.find((l) => l.id === failing?.id);
    expect(failed).toMatchObject({
      status: "PURCHASE_FAILED",
      error: "errors.shipping.notOffered",
    });
    expect(await status(order.id)).toBe("QA");
  });

  it("buys only the missing package on the next Complete QA", async () => {
    const { run, order, provider, packages, qa, rates } = await requested(2);
    const first = (await labels()).find((l) => l.packageId === packages[1]?.id);
    const real = provider.purchaseLabel.bind(provider);
    const spy = vi.spyOn(provider, "purchaseLabel").mockImplementation(async (input) => {
      if (input.idempotencyKey === first?.idempotencyKey) {
        throw new ShippingError("notOffered", "purchaseLabel 422");
      }
      return real(input);
    });
    await run();
    expect(await status(order.id)).toBe("QA");

    // pick another rate for package 2, then Complete QA again
    spy.mockRestore();
    const another = await demoRate(db, packages[1]?.id as string, { amountCents: 600 });
    await db.shippingRate.update({ where: { id: rates[1]?.id }, data: { selected: false } });
    await db.shippingRate.update({ where: { id: another.id }, data: { selected: true } });
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await completeQaWithLabels(db, qa, { orderId: order.id, expectedVersion: fresh.version });
    const before = purchaseCalls(provider);
    await purchaseLabels(
      db,
      { providers: [provider], storage: createMemoryStorage() },
      { orderId: order.id, requestedById: qa.userId },
    );

    expect(purchaseCalls(provider)).toBe(before + 1);
    expect(await status(order.id)).toBe("READY");
    expect((await labels()).filter((l) => l.status === "ACTIVE")).toHaveLength(2);
  });

  it("retries a failed PDF copy without buying again", async () => {
    const { run, provider, storage, order } = await requested(1);
    const put = vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("storage down"));

    await expect(run()).rejects.toThrow();
    let [label] = await labels();
    expect(label).toMatchObject({ status: "ACTIVE", storageKey: null });
    expect(await status(order.id)).toBe("QA");
    expect(purchaseCalls(provider)).toBe(1);

    await run();
    put.mockRestore();
    [label] = await labels();
    expect(label?.storageKey).toBe(`labels/${label?.id}.pdf`);
    expect(purchaseCalls(provider)).toBe(1);
    expect(await status(order.id)).toBe("READY");
  });

  it("leaves the order in QA after a takeover, and the next Complete QA moves it without a provider call", async () => {
    const { run, order, provider } = await requested(1);
    const thief = await createActor(db, ["QA"]);
    await db.order.update({
      where: { id: order.id },
      data: { claimedById: thief.userId, claimedAt: new Date() },
    });

    await run();

    expect((await labels())[0]).toMatchObject({ status: "ACTIVE" });
    expect(await status(order.id)).toBe("QA");

    const calls = purchaseCalls(provider);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const moved = await completeQaWithLabels(db, thief, {
      orderId: order.id,
      expectedVersion: fresh.version,
    });
    expect(moved.status).toBe("READY");
    expect(purchaseCalls(provider)).toBe(calls);
  });

  it("leaves the order in QA when a critical issue is reported during the job", async () => {
    const { run, order } = await requested(1);
    await db.qualityIssue.create({
      data: {
        orderId: order.id,
        type: "DAMAGED_ITEM",
        severity: "CRITICAL",
        description: "Crushed jar",
        discoveredStage: "QA",
      },
    });
    await run();
    expect((await labels())[0]?.status).toBe("ACTIVE");
    expect(await status(order.id)).toBe("QA");
  });

  it("moves the order even when the claim expired while the job ran, if it is still theirs", async () => {
    const { run, order } = await requested(1);
    await db.order.update({ where: { id: order.id }, data: { claimedAt: new Date(0) } });
    await run();
    expect(await status(order.id)).toBe("READY");
  });

  it("finds a label whose response was lost instead of buying again", async () => {
    const { run, provider, order } = await requested(1);
    const real = provider.purchaseLabel.bind(provider);
    vi.spyOn(provider, "purchaseLabel").mockImplementationOnce(async (input) => {
      await real(input); // the provider bought it...
      throw new ShippingError("timeout", "purchaseLabel timeout"); // ...but we never heard
    });

    await expect(run()).rejects.toThrow();
    expect((await labels())[0]).toMatchObject({ status: "PURCHASING" });
    expect((await labels())[0]?.purchaseAttemptedAt).not.toBeNull();

    await run();
    expect(purchaseCalls(provider)).toBe(1);
    expect((await labels())[0]).toMatchObject({ status: "ACTIVE" });
    expect(await status(order.id)).toBe("READY");
  });

  it("never buys again when the provider can't look a label up", async () => {
    const { payload, order, storage } = await requested(1);
    const bridge = {
      id: "SHIPSTATION" as const,
      capabilities: { addressValidation: false, labelLookup: false, void: true, manifests: false },
      purchaseLabel: vi.fn(),
    };
    await db.shippingLabel.updateMany({ data: { purchaseAttemptedAt: new Date() } });

    await purchaseLabels(db, { providers: [bridge as never], storage }, payload);

    expect(bridge.purchaseLabel).not.toHaveBeenCalled();
    expect((await labels())[0]).toMatchObject({
      status: "PURCHASING",
      error: "errors.qa.purchaseUnknown",
    });
    expect(await status(order.id)).toBe("QA");
  });

  it("fails a label without a call when its rate has expired", async () => {
    const { run, provider } = await requested(1);
    await db.shippingRate.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await run();
    expect((await labels())[0]).toMatchObject({
      status: "PURCHASE_FAILED",
      error: "errors.qa.rateExpired",
    });
    expect(purchaseCalls(provider)).toBe(0);
  });

  it("does nothing for an order with no labels to buy", async () => {
    const { run, order } = await requested(1);
    await run();
    await run();
    expect(await status(order.id)).toBe("READY");
  });
});
