import type { Db } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { demoRate, fakeProvider, verifiedQaOrder } from "../../test/qa-fixtures";
import { createMemoryStorage } from "../adapters/storage/memory";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { refreshRates } from "../carriers/rates";
import { keepOriginalAddress, recheckAddress } from "../carriers/ship-to";
import { completeQaWithLabels } from "../qa/complete";
import { voidLabel } from "../qa/labels";
import { purchaseLabels } from "../qa/purchase";
import { selectRate, setRateSelectionReason } from "../qa/rates";
import { createLabelPrint } from "../shipping/print";
import { pushToWoo } from "../shipping/woo-push";
import { retryWooPush } from "../shipping/woo-push-errors";
import { actionMessageKey, actionRegistry } from "./actions";
import { getOrderActivity } from "./timeline";

// SPEC-order-activity: Shipping in the timeline (#202).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

const message = (locale: "en" | "es", key: string) => {
  const action = messages[locale].activity.action as Record<string, string | undefined>;
  return action[key.slice("activity.action.".length)];
};

/** The single package of a one-package order. */
const onlyPackage = <T>({ packages }: { packages: T[] }): T => {
  const [pkg] = packages;
  if (!pkg) throw new Error("no package");
  return pkg;
};

describe("shipping actions", () => {
  it.each(["en", "es"] as const)("are all worded in %s", (locale) => {
    const missing = Object.entries(actionRegistry)
      .filter(([, spec]) => spec.category === "shipping")
      .map(([action]) => action)
      .filter((action) => !message(locale, actionMessageKey(action)));
    expect(missing).toEqual([]);
  });
});

describe("shipping in the order's activity", () => {
  it("shows a pricier rate with its reason, the purchase, print, void and Woo push", async () => {
    const built = await verifiedQaOrder(db, 1);
    const { qa, order } = built;
    const pkg = onlyPackage(built);
    const pricier = await demoRate(db, pkg.id, { amountCents: 750 });
    const admin = await createActor(db, ["ADMIN"]);

    await selectRate(db, qa, { packageId: pkg.id, rateId: pricier.id, reason: "FASTER_DELIVERY" });
    await setRateSelectionReason(db, qa, {
      packageId: pkg.id,
      rateId: pricier.id,
      reason: "CUSTOMER_REQUESTED",
    });
    const { version } = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await completeQaWithLabels(db, qa, {
      orderId: order.id,
      expectedVersion: version,
      confirmCost: true,
    });
    const provider = fakeProvider();
    await purchaseLabels(
      db,
      { providers: [provider], storage: createMemoryStorage() },
      { orderId: order.id, requestedById: qa.userId },
    );
    const label = await db.shippingLabel.findFirstOrThrow({ where: { packageId: pkg.id } });
    expect(label.status).toBe("ACTIVE");
    await createLabelPrint(db, qa, { labelIds: [label.id], idempotencyKey: crypto.randomUUID() });
    await voidLabel(
      db,
      qa,
      { labelId: label.id, reason: "Wrong box size" },
      { providers: [provider] },
    );

    const store = new FakeStoreAdapter();
    const woo = store.addOrder();
    await db.order.update({
      where: { id: order.id },
      data: { status: "COMPLETED", wooOrderId: woo.id, wooPushStatus: "PENDING" },
    });
    await pushToWoo(db, null, { orderId: order.id });
    await retryWooPush(db, admin, { orderIds: [order.id] });
    await pushToWoo(db, store, { orderId: order.id });

    const feed = await getOrderActivity(db, admin, { id: order.id });
    const items = feed.entries.flatMap((e) => (e.count > 1 ? e.members : [e]));
    const find = (action: string) => {
      const item = items.find((i) => i.action === action);
      expect(item, action).toBeDefined();
      expect(item?.category, action).toBe("shipping");
      return item as NonNullable<typeof item>;
    };
    const labelTarget = {
      kind: "label",
      carrier: label.carrierCode,
      trackingEnd: label.trackingNumber?.slice(-6) ?? null,
    };

    expect(find("rate.select")).toMatchObject({
      target: { kind: "box", number: pkg.number },
      params: { service: "Demo Ground", rateReason: "FASTER_DELIVERY" },
    });
    expect(find("rate.reason").params).toMatchObject({ rateReason: "CUSTOMER_REQUESTED" });
    expect(find("labels.purchaseRequested").params).toMatchObject({ count: 1 });
    expect(find("label.purchase").target).toEqual(labelTarget);
    expect(find("label.print")).toMatchObject({ target: labelTarget, params: { count: 1 } });
    expect(find("label.void")).toMatchObject({
      target: labelTarget,
      params: { reason: "Wrong box size" },
    });
    expect(find("label.voided").target).toEqual(labelTarget);
    expect(find("woo.push.failed").system).toBe("shipping");
    expect(find("woo.push.retry").actor?.id).toBe(admin.userId);
    expect(find("woo.push").system).toBe("shipping");
  });

  it("shows rate refreshes and address choices", async () => {
    const { qa, order } = await verifiedQaOrder(db, 1);
    const { shipTo } = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await db.order.update({
      where: { id: order.id },
      data: { shipToStatus: "WARNING", shipToOriginal: shipTo ?? {} },
    });

    await refreshRates(db, qa, { orderId: order.id });
    await keepOriginalAddress(db, qa, { orderId: order.id });
    await recheckAddress(db, qa, { orderId: order.id });

    const feed = await getOrderActivity(db, qa, { id: order.id });
    const actions = feed.entries.map((e) => [e.action, e.category]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ["rates.refresh", "shipping"],
        ["shipTo.useOriginal", "shipping"],
        ["shipTo.recheck", "shipping"],
      ]),
    );
  });

  it("words a cleared rate reason as none", async () => {
    const built = await verifiedQaOrder(db, 1);
    const pkg = onlyPackage(built);
    const pricier = await demoRate(db, pkg.id, { amountCents: 750 });
    await selectRate(db, built.qa, {
      packageId: pkg.id,
      rateId: pricier.id,
      reason: "OTHER",
      note: "Fragile",
    });
    await setRateSelectionReason(db, built.qa, {
      packageId: pkg.id,
      rateId: pricier.id,
      reason: null,
    });

    const feed = await getOrderActivity(db, built.qa, { id: built.order.id });
    const cleared = feed.entries.find((e) => e.action === "rate.reason");
    expect(cleared?.params).toMatchObject({ rateReason: "none" });
  });
});
