import { expect, type Page, test } from "@playwright/test";
import type { Role } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

test.afterAll(deleteCreatedOrders);

/** Ticks a Pending queue row for Pick together, by tapping its box as a picker would. */
async function tick(page: Page, number: string) {
  const box = page.getByRole("checkbox", { name: `Select #${number}` });
  await page.locator("label", { has: box }).click();
  await expect(box).toBeChecked();
}

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

/** Types `code` the way an HID scanner does: a fast burst of keys, then Enter. */
async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

test("a scan counts one unit on its card; a wrong scan shows red and changes nothing", async ({
  page,
}) => {
  await beginPicking(page, 2);
  const card = page.getByTestId("pick-card").first();
  const banner = page.getByTestId("scan-banner");

  // Matched by the line's SKU, whatever the case.
  await scanCode(page, "e2e-sku");
  await expect(banner).toHaveAttribute("data-ok", "true");
  await expect(banner).toHaveText(/E2E item: 1 of 2/);
  await expect(card).toContainText("1 of 2");
  await expect(card).toHaveAttribute("data-flash", "true");

  await scanCode(page, "NOT-A-CODE-1");
  await expect(banner).toHaveAttribute("data-ok", "false");
  await expect(banner).toHaveText(/Woolrus doesn't know that code/);
  await expect(card).toContainText("1 of 2");

  await scanCode(page, "E2E-SKU");
  await expect(card).toContainText("2 of 2");
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");

  await scanCode(page, "E2E-SKU");
  await expect(banner).toHaveText(/E2E item is already picked/);

  // What's shown is what the server kept: the refused scans added nothing.
  await page.reload();
  await expect(page.getByTestId("pick-card").first()).toContainText("2 of 2");
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

test("Out of Stock blocks completion with the message; substituting unblocks it", async ({
  page,
}) => {
  const order = await beginPicking(page, 2);
  const card = page.getByTestId("pick-card").first();
  const complete = page.getByRole("button", { name: "Done", exact: true });

  await card.getByRole("button", { name: "More for E2E item" }).click();
  await page.getByRole("menuitem", { name: "Out of Stock" }).click();
  const outOfStock = page.getByRole("dialog", { name: "E2E item is out of stock" });
  await outOfStock.getByRole("textbox", { name: "How many did you find?" }).fill("1");
  await outOfStock.getByRole("textbox", { name: "Note" }).fill("Only one on the shelf");
  await outOfStock.getByRole("button", { name: "Mark Out of Stock" }).click();
  await expect(outOfStock).toBeHidden();
  await expect(card).toContainText("1 of 2");
  await expect(card.getByTestId("pick-status")).toHaveText(/Out of stock/);

  await complete.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "E2E item is out of stock. Void it or pick a substitute first." }),
  ).toBeVisible();

  await card.getByRole("button", { name: "More for E2E item" }).click();
  await page.getByRole("menuitem", { name: "Substituted" }).click();
  const swap = page.getByRole("dialog", { name: "Substitute E2E item" });
  await swap.getByRole("textbox", { name: "What went in instead" }).fill("One 16 oz jar");
  await swap.getByRole("button", { name: "Mark Substituted" }).click();
  await expect(swap).toBeHidden();
  await expect(card.getByTestId("pick-status")).toHaveText(/Substituted/);
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");

  await complete.click();
  await expect(page).toHaveURL("/queue/pending");
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("Packing");
  await expect(page.getByRole("table", { name: "Items" })).toContainText("One 16 oz jar");
});

test("Pick together starts a batch from three Pending orders; My picks keeps it after a reload", async ({
  page,
}) => {
  const tag = `E2E batch ${crypto.randomUUID()}`;
  const orders = [];
  for (const [index, name] of ["A", "B", "C"].entries()) {
    // Oldest first, so the slots follow creation order.
    orders.push(
      await createOrder({
        customerName: `${tag} ${name}`,
        orderedAt: new Date(Date.now() - (10 - index) * 60_000),
      }),
    );
  }
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(tag);
  await expect(page.getByRole("row", { name: new RegExp(tag) })).toHaveCount(3);

  const pickTogether = page.getByRole("button", { name: /^Pick together/ });
  await expect(pickTogether).toBeDisabled();
  for (const order of orders) {
    await tick(page, order.number);
  }
  await expect(pickTogether).toHaveText("Pick together (3)");
  await pickTogether.click();

  await expect(page).toHaveURL(/\/pick\/batch\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: /^Batch \d+$/ })).toBeVisible();
  for (const [index, order] of orders.entries()) {
    const slot = page.getByTestId(`slot-${index + 1}`);
    await expect(slot).toContainText(`#${order.number}`);
    await expect(slot).toContainText("Picking");
  }

  await page.goto("/pick");
  await page.reload();
  await expect(page.getByRole("heading", { name: "My picks" })).toBeVisible();
  for (const order of orders) {
    await expect(page.getByRole("table", { name: "Slots" })).toContainText(`#${order.number}`);
  }
  await page.getByRole("link", { name: "Open batch" }).click();
  await expect(page).toHaveURL(/\/pick\/batch\//);
});

test("Pick together moves none and says which order someone else took", async ({
  page,
  browser,
}) => {
  const tag = `E2E batch ${crypto.randomUUID()}`;
  const free = await createOrder({ customerName: `${tag} free` });
  const taken = await createOrder({ customerName: `${tag} taken` });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(tag);
  for (const order of [free, taken]) {
    await tick(page, order.number);
  }

  // Another picker begins one of them before this one taps Pick together.
  const other = await browser.newContext();
  try {
    const rival = await other.newPage();
    await signInAs(rival, ["PICKER"]);
    await rival.goto("/queue/pending");
    await rival.getByRole("searchbox", { name: "Search orders" }).fill(`${tag} taken`);
    await rival
      .getByRole("row", { name: new RegExp(taken.number) })
      .getByRole("button", { name: "Begin Picking" })
      .click();
    await expect(rival).toHaveURL(`/pick/${taken.id}`);
  } finally {
    await other.close();
  }

  await page.getByRole("button", { name: "Pick together (2)" }).click();
  const panel = page.getByRole("alert").filter({ hasText: "so none were" });
  await expect(panel).toContainText(`#${taken.number}: E2E PICKER is working on this order.`);
  await expect(page).toHaveURL("/queue/pending");
  await expect(
    page.getByRole("row", { name: new RegExp(free.number) }).getByRole("button", {
      name: "Begin Picking",
    }),
  ).toBeVisible();
});
