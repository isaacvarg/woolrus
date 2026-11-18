import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { ensureShipFrom, packAndFinish } from "./support/rates";
import { withSettingsLock } from "./support/settings-lock";

// SPEC-order-activity criterion 8: one order walked through pick (with a wrong scan), pack and QA;
// its History shows the stage summary and the miss under Problems, and a role with `people` off
// doesn't see who worked each stage (criterion 7). Visibility is global, so it takes the settings
// lock and puts the setting back.

const db = createDb();
test.afterAll(deleteCreatedOrders);

/** Types `code` the way an HID scanner does: a fast burst of keys, then Enter. */
async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

async function openHistory(page: Page, orderId: string) {
  await page.goto(`/orders/${orderId}?tab=history`);
  await expect(page.getByTestId("activity-panel")).toBeVisible();
}

test("an order's History shows its stages, its wrong scan, and hides people from a role", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureShipFrom();
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity: 1 });
  // `createOrder` inserts the row directly; store sync would also write the import's stage event,
  // which is what opens the Pending interval.
  await db.orderStageEvent.create({
    data: { orderId: order.id, toStatus: "PENDING", at: new Date(Date.now() - 60_000) },
  });

  // Pick, with one wrong scan first.
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Begin Picking" })
    .click();
  await expect(page).toHaveURL(`/pick/${order.id}`);
  // The scanner listens once the pick screen has rendered; a scan before that is lost.
  await expect(page.getByRole("heading", { name: `Pick #${order.number}` })).toBeVisible();
  await scanCode(page, "NOT-A-CODE-OA");
  await expect(page.getByTestId("scan-banner")).toBeVisible();
  await scanCode(page, "E2E-SKU");
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL("/queue/pending");

  // Pack, then verify in QA.
  await packAndFinish(page, order, customerName);
  // Start QA from the queue: it claims the order, and an unclaimed order's rows are disabled.
  await signInAs(page, ["QA"]);
  await page.goto("/queue/qa");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start QA" })
    .click();
  await expect(page).toHaveURL(`/qa/${order.id}`, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: `QA #${order.number}` })).toBeVisible();
  await page.getByTestId("qa-row").click();
  await expect(page.getByTestId("qa-package-count")).toHaveText("1 of 1 verified");

  // The summary has a row per stage reached, with people; the miss is under Problems.
  await openHistory(page, order.id);
  const summary = page.getByTestId("activity-summary");
  for (const stage of ["PENDING", "PICKING", "PACKING", "QA"]) {
    await expect(summary.locator(`[data-stage="${stage}"]`)).toBeVisible();
  }
  await expect(summary.locator('[data-stage="PICKING"]')).toContainText("E2E PICKER");
  await page.getByRole("radio", { name: /^Problems/ }).click();
  const problems = page.getByTestId("activity-panel").locator('li[data-category="problems"]');
  await expect(problems).toHaveCount(1);
  await expect(problems).toContainText("NOT-A-CODE-OA");

  await withSettingsLock(async () => {
    const before = (await db.settings.findFirstOrThrow()).activityVisibility;
    try {
      await db.settings.updateMany({ data: { activityVisibility: { PACKER: { people: false } } } });
      await signInAs(page, ["PACKER"]);
      await openHistory(page, order.id);
      // The times stay; nobody's name does.
      await expect(summary.locator('[data-stage="PICKING"]')).toBeVisible();
      await expect(summary).not.toContainText("E2E PICKER");
      await expect(summary).not.toContainText("E2E PACKER");
    } finally {
      await db.settings.updateMany({ data: { activityVisibility: before ?? {} } });
    }
  });
});
