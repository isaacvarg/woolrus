import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { deleteCreatedOrders } from "./support/orders";
import { qaJourneyOrder } from "./support/qa";
import { withSettingsLock } from "./support/settings-lock";

// SPEC-rate-history criterion 12: QA picks the pricier fake rate, says why, buys the label, and the
// reason is shown with the selected rate. CI has no worker, so `runPurchase` runs the purchase job.

const db = createDb();
test.afterAll(async () => {
  await db.shippingLabel.deleteMany({
    where: { package: { order: { customerName: { startsWith: "E2E " } } } },
  });
  await deleteCreatedOrders();
});

test("QA picks the pricier rate with a reason; the label and the drawer carry it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const qa = await signInAs(page, ["QA"]);
  await withSettingsLock(async () => {
    await db.settings.updateMany({
      data: { labelCostConfirmRatio: null, labelCostConfirmFreeCents: null },
    });
    const o = await qaJourneyOrder({ qaUserId: qa.id });
    await db.packageItem.updateMany({
      where: { package: { orderId: o.order.id } },
      data: { qaVerifiedQuantity: 1, qaVerifiedAt: new Date(), qaVerifiedById: qa.id },
    });
    try {
      await page.goto(`/qa/${o.order.id}`);
      // The cheapest rate is selected, so nobody is asked why.
      await expect(page.getByTestId("qa-rate").first()).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("qa-rate-reason")).toHaveCount(0);

      await page.getByTestId("qa-rate").nth(1).click();
      await expect(page.getByTestId("qa-rate").nth(1)).toHaveAttribute("data-selected", "true");
      const reason = page.getByRole("button", { name: /Why this rate\?/ });
      const note = page.getByRole("textbox", { name: "Note" });
      // A note written for Other doesn't come back after another reason replaced it.
      await reason.click();
      await page.getByRole("option", { name: "Other" }).click();
      await note.fill("Customer called");
      await note.blur();
      await reason.click();
      await page.getByRole("option", { name: "Customer requested" }).click();
      await expect(note).toHaveCount(0);
      await reason.click();
      await page.getByRole("option", { name: "Other" }).click();
      await expect(note).toHaveValue("");

      await reason.click();
      await page.getByRole("option", { name: "Faster delivery" }).click();
      await expect(page.getByRole("button", { name: /Why this rate\?/ })).toContainText(
        "Faster delivery",
      );
      await expect
        .poll(
          async () =>
            (
              await db.shippingRate.findFirst({
                where: { package: { orderId: o.order.id }, selected: true },
              })
            )?.selectionReason,
        )
        .toBe("FASTER_DELIVERY");

      await page.getByTestId("qa-complete").click();
      await expect(page.getByTestId("qa-next-order")).toBeVisible();
      await o.runPurchase(qa.id);
      const label = await db.shippingLabel.findFirstOrThrow({
        where: { package: { orderId: o.order.id } },
      });
      expect(label).toMatchObject({ status: "ACTIVE", selectionReason: "FASTER_DELIVERY" });

      await page.reload();
      await page.getByRole("button", { name: "Quick view" }).click();
      await expect(page.getByTestId("qa-drawer-reason")).toHaveText("Why: Faster delivery");

      await page.goto(`/orders/${o.order.id}`);
      await expect(page.getByTestId("order-rate-reason")).toHaveText(
        "Why not the cheapest: Faster delivery",
      );
    } finally {
      await db.settings.updateMany({
        data: { labelCostConfirmRatio: 2, labelCostConfirmFreeCents: 1500 },
      });
      await o.cleanup();
    }
  });
});
