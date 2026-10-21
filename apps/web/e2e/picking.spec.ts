import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

test.afterAll(deleteCreatedOrders);

/** Opens a fresh Pending order from its queue row, as a picker would. */
async function beginPicking(page: Page, quantity: number) {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity, rushOrderLine: true });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Begin Picking" })
    .click();
  await expect(page).toHaveURL(`/pick/${order.id}`);
  await expect(page.getByRole("heading", { name: `Pick #${order.number}` })).toBeVisible();
  return order;
}

test("Begin Picking lands on the pick screen; tap, stepper and undo pick a line", async ({
  page,
}) => {
  await beginPicking(page, 3);
  const cards = page.getByTestId("pick-card");
  // The Rush Order line isn't picked by anyone, so it isn't shown.
  await expect(cards).toHaveCount(1);
  const card = cards.first();
  await expect(card).toContainText("0 of 3");
  await expect(card.getByTestId("pick-status")).toHaveText(/Not picked/);

  await card.getByRole("button", { name: "One more E2E item" }).click();
  await expect(card).toContainText("1 of 3");
  await expect(card.getByTestId("pick-status")).toHaveText(/Partly picked/);
  await expect(page.getByTestId("pick-progress")).toHaveText("0 of 1 lines picked");

  await card.getByRole("button", { name: /^E2E item/, pressed: false }).click();
  await expect(card).toContainText("3 of 3");
  await expect(card.getByTestId("pick-status")).toHaveText(/Picked/);
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");

  // Undo, then reload: what's shown is what the server kept.
  await card.getByRole("button", { name: /^E2E item/, pressed: true }).click();
  await expect(card).toContainText("0 of 3");
  await page.reload();
  await expect(page.getByTestId("pick-card").first()).toContainText("0 of 3");
});

test("completing with a line unpicked shows what's missing; once picked it moves on", async ({
  page,
}) => {
  const order = await beginPicking(page, 1);
  const complete = page.getByRole("button", { name: "Complete Picking" });

  await complete.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "E2E item hasn't been picked." }),
  ).toBeVisible();

  await page
    .getByTestId("pick-card")
    .getByRole("button", { name: /^E2E item/ })
    .click();
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");
  await complete.click();
  await expect(page).toHaveURL("/queue/pending");

  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("Packing");
  // Who picked it, on the order's line (FR-WF-04).
  await expect(page.getByRole("table", { name: "Items" })).toContainText("E2E PICKER");
});

test("the cards are locked for someone who doesn't hold the claim", async ({ page, browser }) => {
  const order = await beginPicking(page, 1);
  const other = await browser.newContext();
  try {
    const watcher = await other.newPage();
    await signInAs(watcher, ["PICKER"]);
    await watcher.goto(`/pick/${order.id}`);
    await expect(
      watcher.getByText("E2E PICKER is picking this order.", { exact: false }),
    ).toBeVisible();
    await expect(watcher.getByTestId("pick-card").getByRole("button").first()).toBeDisabled();
  } finally {
    await other.close();
  }
});
