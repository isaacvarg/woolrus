import { expect, test } from "@playwright/test";
import { createStoreAdapter, pushToWoo, syncOrders } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { qaJourneyOrder } from "./support/qa";
import { withSettingsLock } from "./support/settings-lock";
import { createStoreOrder, deleteStoreOrder } from "./support/woo";

// SPEC.md go-live checklist and SPEC-shipping criterion 16: one order goes import → QA → label →
// ship → the dev WooCommerce shows Completed with its tracking, once with tracking off (a customer
// note) and once with it on (an AST tracking item). The store is the dev stack's (`pnpm stack:up`,
// E2E_DEV_STACK=1); the carrier is the fake, and CI has no store, so it skips there. The jobs the
// worker would run (labels.purchase, woo.push) are run in this process.
//
// The pick and pack screens have their own journeys (picking.spec, packing-journey.spec); here the
// imported order is put where packing leaves it, in QA, with its package and rates.

const db = createDb();
const store = createStoreAdapter({
  url: process.env.WOO_URL ?? "http://localhost:8090",
  consumerKey: process.env.WOO_CONSUMER_KEY ?? "",
  consumerSecret: process.env.WOO_CONSUMER_SECRET ?? "",
});

test.describe("the go-live journey against the dev store", () => {
  test.skip(!process.env.E2E_DEV_STACK, "needs the dev store (E2E_DEV_STACK=1)");
  test.describe.configure({ mode: "serial" });
  test.slow();

  for (const tracking of [false, true]) {
    test(`import, QA, label, ship and push with tracking ${tracking ? "on" : "off"}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "one store order per run");
      test.setTimeout(180_000);
      if (tracking) test.skip(!(await store.hasShipmentTracking()), "the dev store has no AST");
      const lastName = `Golive ${crypto.randomUUID().slice(0, 8)}`;
      const storeOrder = await createStoreOrder(lastName);
      const settings = await db.settings.upsert({
        where: { id: 1 },
        create: { id: 1 },
        update: {},
      });
      let cleanup: (() => Promise<void>) | undefined;
      try {
        await withSettingsLock(async () => {
          await db.settings.update({ where: { id: 1 }, data: { wooTrackingEnabled: tracking } });

          // Import: the real order from the dev store.
          const imported = await syncOrders(db, store, {
            type: "ORDERS_WEBHOOK",
            orderIds: [storeOrder.id],
          });
          expect(imported).toMatchObject({ status: "SUCCEEDED" });
          const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: storeOrder.id } });
          expect(order.status).toBe("PENDING");

          // QA: scan/tap, Complete QA; the purchase job runs against the fake carrier.
          const qa = await signInAs(page, ["QA"]);
          const journey = await qaJourneyOrder({ qaUserId: qa.id, existingOrderId: order.id });
          cleanup = async () => {
            await db.shippingLabel.deleteMany({ where: { package: { orderId: order.id } } });
            await journey.cleanup().catch(() => {});
          };
          await page.goto(`/qa/${order.id}`);
          await page.getByTestId("qa-row").first().click();
          await expect(page.getByTestId("qa-all-done")).toBeVisible();
          await page.getByTestId("qa-complete").click();
          await expect(page.getByTestId("qa-next-order")).toBeVisible();
          await journey.runPurchase(qa.id);
          expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
            "READY",
          );
          const label = await db.shippingLabel.findFirstOrThrow({
            where: { package: { orderId: order.id }, status: "ACTIVE" },
          });

          // Ship: a shipper ticks it in the Ready queue (the label was never printed: confirm).
          await page.context().clearCookies();
          await signInAs(page, ["SHIPPER"]);
          await page.goto("/queue/ready");
          await page.getByRole("searchbox", { name: "Search orders" }).fill(order.number);
          const box = page.getByRole("checkbox", { name: `Select #${order.number}` });
          await page.locator("label", { has: box }).click();
          await page.getByRole("button", { name: "Ship (1)" }).click();
          await page.getByRole("button", { name: "Ship anyway" }).click();
          await expect(page.getByText("1 order shipped.")).toBeVisible();
          expect(
            (await db.order.findUniqueOrThrow({ where: { id: order.id } })).wooPushStatus,
          ).toBe("PENDING");

          // The worker's woo.push against the dev store.
          expect(await pushToWoo(db, store, { orderId: order.id })).toEqual({
            outcome: "succeeded",
          });
          const woo = await store.getOrder(storeOrder.id);
          expect(woo?.status).toBe("completed");
          const number = label.trackingNumber as string;
          const notes = await store.listOrderNotes(storeOrder.id);
          if (tracking) {
            const trackings = await store.listShipmentTrackings(storeOrder.id);
            expect(trackings.map((t) => t.trackingNumber)).toEqual([number]);
            expect(notes.some((n) => n.customerNote && n.note.includes(number))).toBe(false);
          } else {
            expect(notes.filter((n) => n.customerNote && n.note.includes(number))).toHaveLength(1);
          }

          await page.goto(`/orders/${order.id}`);
          await expect(page.getByText("Sent to Woo")).toBeVisible();
          await expect(page.getByTestId("order-labels")).toContainText(number);
        });
      } finally {
        await db.settings.update({
          where: { id: 1 },
          data: { wooTrackingEnabled: settings.wooTrackingEnabled },
        });
        await cleanup?.();
        await deleteStoreOrder(storeOrder.id);
      }
    });
  }
});
