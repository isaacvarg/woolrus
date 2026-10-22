import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

test.afterAll(deleteCreatedOrders);

/** Types `code` the way an HID scanner does: a fast burst of keys, then Enter. */
async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

test("a batch scan fills slots in order and calls out each one; a wrong scan changes nothing", async ({
  page,
}) => {
  const tag = `E2E batch scan ${crypto.randomUUID()}`;
  const orders = [];
  // Same SKU on every order; oldest first, so slots follow creation. Slot 2 needs two.
  for (const [index, quantity] of [1, 2, 1].entries()) {
    orders.push(
      await createOrder({
        customerName: `${tag} ${index + 1}`,
        quantity,
        orderedAt: new Date(Date.now() - (10 - index) * 60_000),
      }),
    );
  }
  const [one, two, three] = orders as [(typeof orders)[0], (typeof orders)[0], (typeof orders)[0]];
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(tag);
  for (const order of orders) {
    const box = page.getByRole("checkbox", { name: `Select #${order.number}` });
    await page.locator("label", { has: box }).click();
    await expect(box).toBeChecked();
  }
  await page.getByRole("button", { name: "Pick together (3)" }).click();
  await expect(page).toHaveURL(/\/pick\/batch\/[0-9a-f-]+$/);
  const left = page.getByTestId("group-left");
  await expect(left).toHaveText("4 of 4 left");

  const callout = page.getByTestId("slot-callout");
  for (const [order, slot, remaining] of [
    [one, 1, 3],
    [two, 2, 2],
    [two, 2, 1],
    [three, 3, 0],
  ] as const) {
    await scanCode(page, "e2e-sku");
    await expect(callout).toHaveAttribute("data-slot", String(slot));
    await expect(callout).toContainText(`Slot ${slot} · #${order.number}`);
    await expect(left).toHaveText(`${remaining} of 4 left`);
    await expect(page.getByTestId(`chip-${slot}`)).toHaveAttribute("data-scanned", "true");
  }
  await expect(page.getByTestId("chip-2")).toHaveAttribute("data-status", "PICKED");

  const banner = page.getByTestId("scan-banner");
  await scanCode(page, "E2E-SKU");
  await expect(banner).toHaveAttribute("data-ok", "false");
  await expect(banner).toHaveText(/E2E item is already picked/);
  await expect(callout).toHaveCount(0);

  await scanCode(page, "NOT-A-CODE-3");
  await expect(banner).toHaveText(/Woolrus doesn't know that code/);

  // What's shown is what the server kept: the refused scans added nothing.
  await page.reload();
  await expect(page.getByTestId("group-left")).toHaveText("0 of 4 left");
  for (const slot of [1, 2, 3]) {
    await expect(page.getByTestId(`chip-${slot}`)).toHaveAttribute("data-status", "PICKED");
  }
});

test("someone else can't scan into my batch through the API", async ({ page, browser }) => {
  const tag = `E2E batch scan ${crypto.randomUUID()}`;
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
  const { id } = await created.json();

  const other = await (await browser.newContext()).newPage();
  try {
    await signInAs(other, ["PICKER"]);
    const response = await other.request.post(`/api/v1/pick-batches/${id}/scan`, {
      data: { code: "E2E-SKU", scanId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(403);
  } finally {
    await other.context().close();
  }

  const mine = await page.request.post(`/api/v1/pick-batches/${id}/scan`, {
    data: { code: "E2E-SKU", scanId: crypto.randomUUID() },
  });
  expect(mine.status()).toBe(200);
  expect(await mine.json()).toMatchObject({ slot: 1 });
});
