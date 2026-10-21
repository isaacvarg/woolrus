import { expect, type Page, test } from "@playwright/test";
import type { Role } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

test.afterAll(deleteCreatedOrders);

/** Opens a fresh Pending order from its queue row, as a picker would. */
async function beginPicking(page: Page, quantity: number, roles: Role[] = ["PICKER"]) {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity, rushOrderLine: true });
  await signInAs(page, roles);
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

/** Taps the order's only line so it can complete. */
async function pickAll(page: Page) {
  await page
    .getByTestId("pick-card")
    .getByRole("button", { name: /^E2E item/ })
    .click();
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");
}

test("Done with a line unpicked shows what's missing; once picked it returns to Pending", async ({
  page,
}) => {
  const order = await beginPicking(page, 1);
  const complete = page.getByRole("button", { name: "Done", exact: true });

  await complete.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "E2E item hasn't been picked." }),
  ).toBeVisible();

  await pickAll(page);
  await complete.click();
  await expect(page).toHaveURL("/queue/pending");

  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("Packing");
  // Who picked it, on the order's line (FR-WF-04).
  await expect(page.getByRole("table", { name: "Items" })).toContainText("E2E PICKER");
});

test("Done, next order begins and opens the next Pending order", async ({ page }) => {
  const order = await beginPicking(page, 1);
  // Above anything else in the shared dev queue, so it's what comes next (or the other project's twin).
  await createOrder({ priority: 2_000_000_000, orderedAt: new Date(2000, 0, 1) });
  // A picker who can't pack isn't offered packing it.
  await expect(page.getByRole("button", { name: "Done, open in Packing" })).toHaveCount(0);

  await pickAll(page);
  await page.getByRole("button", { name: "Done, next order" }).click();

  await expect(page).not.toHaveURL(`/pick/${order.id}`);
  await expect(page).toHaveURL(/\/pick\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /^Pick #/ })).toBeVisible();
  // It's in Picking and claimed by this picker: the cards are live, no banner.
  await expect(page.getByTestId("pick-card").first().getByRole("button").first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "Done, next order" })).toBeVisible();

  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("Packing");
});

test("Done, open in Packing claims the order for the picker in Packing", async ({ page }) => {
  const order = await beginPicking(page, 1, ["PICKER", "PACKER"]);

  await pickAll(page);
  await page.getByRole("button", { name: "Done, open in Packing" }).click();

  await expect(page).toHaveURL(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("Packing");
  await expect(page.getByText(/Claimed by E2E PICKER\+PACKER/)).toBeVisible();
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
