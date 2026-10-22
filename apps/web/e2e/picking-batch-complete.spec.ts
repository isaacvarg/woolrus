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

  // Slots 1 and 3 picked; slot 2 left as it is. While a tap is still saving, Complete waits: the
  // screen counts the order ready before the server has the pick.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pickLine = /\/rpc\/picking\/pickLine/;
  await page.route(pickLine, async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: /^Slot 1, order/ }).click();
  await expect(completeReady).toHaveText("Complete ready orders (1)");
  await expect(completeReady).toBeDisabled();
  release();
  await expect(completeReady).toBeEnabled();
  await page.unroute(pickLine);
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

  // A member's own pick screen leads back to its batch; the removed order's doesn't.
  const batchUrl = page.url();
  await page.goto(`/pick/${removed.id}`);
  await expect(page.getByRole("heading", { name: `Pick #${removed.number}` })).toBeVisible();
  await expect(page.getByTestId("pick-batch-link")).toHaveCount(0);
  await page.goto(`/pick/${(orders[0] as (typeof orders)[number]).id}`);
  await page.getByTestId("pick-batch-link").click();
  await expect(page).toHaveURL(batchUrl);

  await page.goto("/pick");
  await expect(page.getByRole("link", { name: "Open batch" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Orders I'm picking" }).getByRole("link"),
  ).toHaveText([new RegExp(`#${removed.number}`)]);
});

test("a Complete refused because the batch was finished elsewhere shows the batch as it is", async ({
  page,
}) => {
  const tag = `E2E batch ${crypto.randomUUID()}`;
  const orders = [];
  for (const index of [0, 1]) {
    orders.push(await createOrder({ customerName: `${tag} ${index + 1}` }));
  }
  await signInAs(page, ["PICKER"]);
  const created = await page.request.post("/api/v1/pick-batches", {
    data: {
      idempotencyKey: crypto.randomUUID(),
      orders: orders.map((o) => ({ id: o.id, expectedVersion: o.version })),
    },
  });
  expect(created.status()).toBe(200);
  const batch = await created.json();
  const itemId = batch.groups[0].chips.find((c: { slot: number }) => c.slot === 1).line.id;
  expect(
    (await page.request.post(`/api/v1/order-items/${itemId}/pick`, { data: {} })).status(),
  ).toBe(200);
  // No order events: only the refused Complete itself may bring the screen up to date (any order
  // changing on the shared dev stack would refetch the batch otherwise).
  await page.route("**/api/events/orders", (route) => route.abort());
  await page.goto(`/pick/batch/${batch.id}`);
  const completeReady = page.getByRole("button", { name: /^Complete ready orders/ });
  await expect(completeReady).toHaveText("Complete ready orders (1)");

  // Finished on another tablet; this screen doesn't know yet.
  expect((await page.request.post(`/api/v1/pick-batches/${batch.id}/finish`)).status()).toBe(200);
  await completeReady.click();

  await expect(page.getByRole("button", { name: "Finish batch" })).toHaveCount(0);
  await expect(page.locator("p.alert")).toHaveText("This batch is finished.");
});
