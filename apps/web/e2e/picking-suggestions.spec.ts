import { type APIResponse, expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// Suggested batches on the Pending queue (SPEC-picking A1, criterion 22; ticket #191).
//
// Suggestions span the whole Pending queue, which tests share. Each test's orders share a SKU of
// their own (e2e lines have no product, so the SKU is what's on the shelf) and sit just below the
// 2,000,000,000 that "Done, next order" tests use, so no other test takes them and they start a
// card of their own. The card is found by its orders, not its position.

const db = createDb();
// After each test, not all: a test's leftover top orders would start cards ahead of the next one's.
test.afterEach(deleteCreatedOrders);
test.afterAll(() => db.$disconnect());

const TOP = 1_999_999_999;

/** Three Pending orders sharing a SKU of their own, oldest first. */
async function sharingOrders() {
  const sku = `E2E-SUG-${crypto.randomUUID()}`;
  const orders = [];
  for (const index of [0, 1, 2]) {
    orders.push(
      await createOrder({ sku, priority: TOP, orderedAt: new Date(2000, 0, 2, 0, index) }),
    );
  }
  return orders;
}

const cardOf = (page: Page, number: string) =>
  page.getByRole("article").filter({ hasText: `#${number}` });

test("Pick these starts a batch with exactly the card's orders, in queue order", async ({
  page,
}) => {
  const orders = await sharingOrders();
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");

  await expect(page.getByRole("heading", { name: "Suggested batches" })).toBeVisible();
  const card = cardOf(page, orders[0]?.number as string);
  for (const order of orders) await expect(card).toContainText(`#${order.number}`);
  await expect(card).toContainText("3 orders · 6 items · 1 stop");
  await expect(card).toContainText("E2E item ×6 · 3 orders");

  await card.getByRole("button", { name: "Pick these" }).click();

  await expect(page).toHaveURL(/\/pick\/batch\/[0-9a-f-]+$/);
  for (const [index, order] of orders.entries()) {
    const slot = page.getByTestId(`slot-${index + 1}`);
    await expect(slot).toContainText(`#${order.number}`);
    await expect(slot).toContainText("Picking");
  }
  await expect(page.getByTestId("slot-4")).toHaveCount(0);
});

test("an order someone else took first is refused by name, and the cards refresh without it", async ({
  page,
  browser,
}) => {
  const [first, taken, third] = (await sharingOrders()) as [
    Awaited<ReturnType<typeof createOrder>>,
    Awaited<ReturnType<typeof createOrder>>,
    Awaited<ReturnType<typeof createOrder>>,
  ];
  // The race a live refresh can't close: the cards were read just before someone else took an
  // order. Any order event (another test's, in the shared queue) refetches them, so the first
  // read is held until the tap; the refetch after the refusal goes through.
  let held: APIResponse | undefined;
  let tapped = false;
  await page.route(/suggestions/, async (route) => {
    if (tapped) return route.continue();
    held ??= await route.fetch();
    return route.fulfill({ response: held });
  });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  const card = cardOf(page, first.number);
  await expect(card).toContainText(`#${taken.number}`);

  // Another picker claims it on their own browser.
  const other = await browser.newContext();
  try {
    const holder = await signInAs(await other.newPage(), ["PICKER", "PACKER"]);
    await db.order.update({
      where: { id: taken.id },
      data: { claimedById: holder.id, claimedAt: new Date() },
    });

    tapped = true;
    await card.getByRole("button", { name: "Pick these" }).click();

    const alert = page.getByRole("alert").filter({ hasText: "couldn't" });
    await expect(alert).toContainText(`#${taken.number}`);
    await expect(alert).toContainText("E2E PICKER+PACKER");
    await expect(page).toHaveURL("/queue/pending");
    await expect(card).toContainText(`#${third.number}`);
    await expect(card).not.toContainText(`#${taken.number}`);
  } finally {
    await other.close();
  }
});

test("suggestions hide while the queue is searched", async ({ page }) => {
  await sharingOrders();
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  const heading = page.getByRole("heading", { name: "Suggested batches" });
  await expect(heading).toBeVisible();

  await page.getByRole("searchbox", { name: "Search orders" }).fill("E2E");
  await expect(heading).toHaveCount(0);
});

// Ticket #193: the picker adjusts a suggestion before picking it.
test("Select these ticks exactly the card's orders; unticking one picks the rest together", async ({
  page,
}) => {
  const orders = await sharingOrders();
  const [first, dropped, last] = orders as [
    Awaited<ReturnType<typeof createOrder>>,
    Awaited<ReturnType<typeof createOrder>>,
    Awaited<ReturnType<typeof createOrder>>,
  ];
  // Ticked before the tap, and not on the card: Select these clears it.
  const other = await createOrder({ sku: `E2E-SUG-${crypto.randomUUID()}`, priority: TOP });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");

  const box = (number: string) => page.getByRole("checkbox", { name: `Select #${number}` });
  const toggle = (number: string) => page.locator("label", { has: box(number) }).click();
  const pickTogether = page.getByRole("button", { name: /^Pick together/ });

  await toggle(other.number);
  await expect(box(other.number)).toBeChecked();

  const card = cardOf(page, first.number);
  await card.getByRole("button", { name: "Select these" }).click();

  for (const order of orders) await expect(box(order.number)).toBeChecked();
  await expect(box(other.number)).not.toBeChecked();
  await expect(pickTogether).toHaveText("Pick together (3)");

  await toggle(dropped.number);
  await expect(box(dropped.number)).not.toBeChecked();
  await expect(pickTogether).toHaveText("Pick together (2)");
  await pickTogether.click();

  await expect(page).toHaveURL(/\/pick\/batch\/[0-9a-f-]+$/);
  await expect(page.getByTestId("slot-1")).toContainText(`#${first.number}`);
  await expect(page.getByTestId("slot-2")).toContainText(`#${last.number}`);
  await expect(page.getByTestId("slot-3")).toHaveCount(0);
});
