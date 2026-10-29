import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { deleteCreatedOrders } from "./support/orders";
import { qaJourneyOrder } from "./support/qa";
import { withSettingsLock } from "./support/settings-lock";

// SPEC-qa criterion 18: the QA journey end to end against the fake ShipStation. CI starts no
// worker, so the `labels.purchase` job Complete QA enqueues is run by `runPurchase`. Provider
// accounts and the cost thresholds are global, so each test takes its turn through withSettingsLock.

const db = createDb();
test.afterAll(async () => {
  await db.shippingLabel.deleteMany({
    where: { package: { order: { customerName: { startsWith: "E2E " } } } },
  });
  await deleteCreatedOrders();
});

/** Types `code` the way an HID scanner does: a fast burst of keys, then Enter. */
async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

const restoreThresholds = () =>
  db.settings.updateMany({ data: { labelCostConfirmRatio: 2, labelCostConfirmFreeCents: 1500 } });

const orderStatus = async (id: string) =>
  (await db.order.findUniqueOrThrow({ where: { id } })).status;

test("scan and tap every item, change a rate, complete, and the order is Ready with tracking", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const qa = await signInAs(page, ["QA"]);
  await withSettingsLock(async () => {
    await db.settings.updateMany({
      data: { labelCostConfirmRatio: null, labelCostConfirmFreeCents: null },
    });
    const o = await qaJourneyOrder({ qaUserId: qa.id, packages: 2 });
    try {
      await page.goto(`/qa/${o.order.id}`);
      await expect(page.getByTestId("qa-package-count").first()).toHaveText("0 of 1 verified");

      // Package 1 by scanner, package 2 by tap.
      await scanCode(page, o.sku);
      await expect(page.getByTestId("qa-package-count").first()).toHaveText("1 of 1 verified");
      await page.getByTestId("qa-row").nth(1).click();
      await expect(page.getByTestId("qa-all-done")).toBeVisible();

      // The dearer rate on package 2.
      await page.getByTestId("qa-package").nth(1).getByTestId("qa-rate").nth(1).click();
      await expect(
        page.getByTestId("qa-package").nth(1).getByTestId("qa-rate").nth(1),
      ).toHaveAttribute("data-selected", "true");

      await page.getByTestId("qa-complete").click();
      await expect(page.getByTestId("qa-next-order")).toBeVisible();
      await o.runPurchase(qa.id);
      expect(await orderStatus(o.order.id)).toBe("READY");

      await page.reload();
      await expect(page.getByTestId("qa-label")).toHaveCount(2);
      const labels = await db.shippingLabel.findMany({
        where: { package: { orderId: o.order.id } },
        orderBy: { package: { number: "asc" } },
      });
      expect(labels.map((l) => l.status)).toEqual(["ACTIVE", "ACTIVE"]);
      expect(labels.map((l) => l.costCents)).toEqual([450, 600]);
      for (const label of labels) {
        await expect(
          page.getByTestId("qa-label").filter({ hasText: label.trackingNumber ?? "?" }),
        ).toBeVisible();
      }
    } finally {
      await restoreThresholds();
      await o.cleanup();
    }
  });
});

test("a refused label shows the failure; a new rate and a second Complete QA reach Ready", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const qa = await signInAs(page, ["QA"]);
  await withSettingsLock(async () => {
    await db.settings.updateMany({
      data: { labelCostConfirmRatio: null, labelCostConfirmFreeCents: null },
    });
    const o = await qaJourneyOrder({ qaUserId: qa.id, packages: 2, address2: "FAIL-BUY-2" });
    await db.packageItem.updateMany({
      where: { package: { orderId: o.order.id } },
      data: { qaVerifiedQuantity: 1, qaVerifiedAt: new Date(), qaVerifiedById: qa.id },
    });
    try {
      await page.goto(`/qa/${o.order.id}`);
      await page.getByTestId("qa-complete").click();
      await expect(page.getByTestId("qa-next-order")).toBeVisible();
      await o.runPurchase(qa.id);

      // Package 1 is bought, package 2 refused: the order stays in QA.
      await page.reload();
      await expect(page.getByTestId("qa-failed")).toContainText("1 of 2 labels bought.");
      await expect(page.getByTestId("qa-failed-package")).toContainText("Package 2:");
      expect(await orderStatus(o.order.id)).toBe("QA");

      // The fix: the address line that tripped the fake is gone, and a different rate is chosen.
      await db.order.update({
        where: { id: o.order.id },
        data: {
          shipTo: {
            name: "E2E Customer",
            address1: "1 Main St",
            city: "Austin",
            state: "TX",
            postalCode: "78701",
            country: "US",
          },
        },
      });
      await page.getByTestId("qa-package").nth(1).getByTestId("qa-rate").nth(1).click();
      await expect(
        page.getByTestId("qa-package").nth(1).getByTestId("qa-rate").nth(1),
      ).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("qa-complete")).toBeVisible();
      await page.getByTestId("qa-complete").click();
      await expect(page.getByTestId("qa-next-order")).toBeVisible();
      await o.runPurchase(qa.id);
      expect(await orderStatus(o.order.id)).toBe("READY");

      await page.reload();
      await expect(page.getByTestId("qa-failed")).toHaveCount(0);
      await expect(page.getByTestId("qa-label")).toHaveCount(2);
    } finally {
      await restoreThresholds();
      await o.cleanup();
    }
  });
});

test("an open critical issue blocks Complete QA and says why; resolving it unblocks", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const qa = await signInAs(page, ["QA"]);
  await withSettingsLock(async () => {
    const o = await qaJourneyOrder({ qaUserId: qa.id });
    await db.packageItem.updateMany({
      where: { package: { orderId: o.order.id } },
      data: { qaVerifiedQuantity: 1, qaVerifiedAt: new Date(), qaVerifiedById: qa.id },
    });
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: o.order.id } });
    const issue = await db.qualityIssue.create({
      data: {
        orderId: o.order.id,
        orderItemId: item.id,
        type: "DAMAGED_ITEM",
        severity: "CRITICAL",
        description: "Cracked in the box",
        discoveredStage: "QA",
      },
    });
    try {
      await page.goto(`/qa/${o.order.id}`);
      // Nothing is hidden: the row is still there, and the button is replaced by the reason.
      await expect(page.getByTestId("qa-row")).toBeVisible();
      await expect(page.getByTestId("qa-critical")).toBeVisible();
      await expect(page.getByTestId("qa-complete")).toHaveCount(0);
      await expect(page.getByTestId("qa-unmet")).toContainText(
        "Resolve the 1 open critical issue(s) before the order can leave QA.",
      );

      await db.qualityIssue.update({
        where: { id: issue.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNotes: "Replaced" },
      });
      await page.reload();
      await expect(page.getByTestId("qa-complete")).toBeVisible();
    } finally {
      await db.qualityIssue.deleteMany({ where: { orderId: o.order.id } });
      await o.cleanup();
    }
  });
});

test("an order over the cost threshold asks before buying, then reaches Ready", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const qa = await signInAs(page, ["QA"]);
  await withSettingsLock(async () => {
    await db.settings.updateMany({
      data: { labelCostConfirmRatio: 2, labelCostConfirmFreeCents: 1500 },
    });
    // The customer paid $1.00 for shipping; the label is $4.50.
    const o = await qaJourneyOrder({ qaUserId: qa.id, shippingChargedCents: 100 });
    await db.packageItem.updateMany({
      where: { package: { orderId: o.order.id } },
      data: { qaVerifiedQuantity: 1, qaVerifiedAt: new Date(), qaVerifiedById: qa.id },
    });
    try {
      await page.goto(`/qa/${o.order.id}`);
      await page.getByTestId("qa-complete").click();
      await expect(page.getByTestId("qa-cost-confirm-body")).toHaveText(
        "Labels cost $4.50, the customer paid $1.00 for shipping. Buy anyway?",
      );
      expect(await db.shippingLabel.count({ where: { package: { orderId: o.order.id } } })).toBe(0);
      await page.getByTestId("qa-cost-confirm").click();
      await expect(page.getByTestId("qa-next-order")).toBeVisible();
      await o.runPurchase(qa.id);
      expect(await orderStatus(o.order.id)).toBe("READY");
    } finally {
      await db.settings.updateMany({
        data: { labelCostConfirmRatio: 2, labelCostConfirmFreeCents: 1500 },
      });
      await o.cleanup();
    }
  });
});
