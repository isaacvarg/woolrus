import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

test.afterAll(deleteCreatedOrders);

/** Ticks a Pending queue row for Pick together, by tapping its box as a picker would. */
async function tick(page: Page, number: string) {
  const box = page.getByRole("checkbox", { name: `Select #${number}` });
  await page.locator("label", { has: box }).click();
  await expect(box).toBeChecked();
}

test("a batch completes its ready orders, says what the other still needs, and finishes", async ({
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
  const [a, b, c] = orders as [
    (typeof orders)[number],
    (typeof orders)[number],
    (typeof orders)[number],
  ];
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(tag);
  for (const order of orders) {
    await tick(page, order.number);
  }
  await page.getByRole("button", { name: "Pick together (3)" }).click();
  await expect(page).toHaveURL(/\/pick\/batch\/[0-9a-f-]+$/);

  const completeReady = page.getByRole("button", { name: /^Complete ready orders/ });
  await expect(completeReady).toHaveText("Complete ready orders (0)");
  await expect(completeReady).toBeDisabled();

  // Slots 1 and 3 picked; slot 2 left as it is.
  await page.getByRole("button", { name: /^Slot 1, order/ }).click();
  await page.getByRole("button", { name: /^Slot 3, order/ }).click();
  await expect(page.getByTestId("chip-3")).toHaveAttribute("data-status", "PICKED");
  await expect(completeReady).toHaveText("Complete ready orders (2)");

  await completeReady.click();
  const results = page.getByTestId("batch-results");
  await expect(results).toContainText(`Moved to Packing: #${a.number}, #${c.number}`);
  await expect(page.getByTestId("slot-1")).toContainText("Left: Packing");
  await expect(page.getByTestId("slot-3")).toContainText("Left: Packing");
  await expect(page.getByTestId("slot-2")).toContainText("Picking");

  // Completing slot 2 on its own is refused with what's missing; it stays in the batch.
  await page.getByRole("button", { name: `Complete slot 2, order #${b.number}` }).click();
  await expect(results).toContainText(`#${b.number} stays in Picking:`);
  await expect(results).toContainText("E2E item hasn't been picked.");
  await expect(page.getByTestId("slot-2")).toContainText("Picking");

  await page.getByRole("button", { name: "Finish batch" }).click();
  await expect(page).toHaveURL(/\/pick$/);
  await expect(page.getByRole("heading", { name: "My picks" })).toBeVisible();
  await page.reload();
  // No open batch any more; the unfinished order is still mine, on its own.
  await expect(page.getByRole("link", { name: "Open batch" })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Slots" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Orders I'm picking" }).getByRole("link"),
  ).toHaveText([new RegExp(`#${b.number}`)]);
});

test("Remove takes an order out of the batch; it stays mine in My picks", async ({ page }) => {
  const tag = `E2E batch ${crypto.randomUUID()}`;
  const orders = [];
  for (const [index, name] of ["A", "B", "C"].entries()) {
    orders.push(
      await createOrder({
        customerName: `${tag} ${name}`,
        orderedAt: new Date(Date.now() - (10 - index) * 60_000),
      }),
    );
  }
  const removed = orders[1] as (typeof orders)[number];
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(tag);
  for (const order of orders) {
    await tick(page, order.number);
  }
  await page.getByRole("button", { name: "Pick together (3)" }).click();
  await expect(page).toHaveURL(/\/pick\/batch\/[0-9a-f-]+$/);

  await page
    .getByRole("button", { name: `Remove slot 2, order #${removed.number} from the batch` })
    .click();
  await expect(page.getByTestId("slot-2")).toContainText("Removed");
  await expect(page.getByTestId("chip-2")).toHaveCount(0);

  await page.goto("/pick");
  await expect(page.getByRole("link", { name: "Open batch" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Orders I'm picking" }).getByRole("link"),
  ).toHaveText([new RegExp(`#${removed.number}`)]);
});
