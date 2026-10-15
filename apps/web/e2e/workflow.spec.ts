import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { withSettingsLock } from "./support/settings-lock";

/** On tablet width the nav is a drawer behind the menu button. */
async function openNav(page: Page) {
  const menu = page.getByLabel("Open menu");
  if (await menu.isVisible()) await menu.click();
}

test.afterAll(async () => {
  await deleteCreatedOrders();
});

const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

/** Narrows a queue to one test's orders: every test uses its own customer name. */
async function searchQueue(page: Page, text: string) {
  await page.getByRole("searchbox", { name: "Search orders" }).fill(text);
}

test("the nav lists every queue with a count, and All Orders", async ({ page }) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await openNav(page);
  const nav = page.getByRole("navigation");
  for (const name of ["Pending", "Picking", "Packing", "QA", "Ready", "On Hold"]) {
    await expect(nav.getByRole("link", { name: new RegExp(`^${name} \\d+$`) })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "All Orders" })).toBeVisible();
});

test("a queue row shows priority, items, a past-SLA stage age and the claim holder", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  const order = await createOrder({ customerName, priority: 2, quantity: 3, statusChangedAt: old });
  // Admin: the only role that can set an SLA, and it reads queues like everyone else.
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    const before = (await (await page.request.get("/api/v1/settings")).json()).stageSlaMinutes;
    try {
      await page.request.patch("/api/v1/settings", {
        data: { stageSlaMinutes: { ...before, PENDING: 24 * 60 } },
      });
      await page.goto("/queue/pending");
      await searchQueue(page, customerName);

      const row = page.getByRole("row", { name: new RegExp(order.number) });
      await expect(row).toContainText(customerName);
      await expect(row.getByText("Urgent")).toBeVisible();
      await expect(row.getByRole("cell", { name: "3", exact: true })).toBeVisible();
      await expect(row.getByText("3 d", { exact: true })).toHaveClass(/text-error/);
    } finally {
      await page.request.patch("/api/v1/settings", { data: { stageSlaMinutes: before } });
    }
  });
});

test("a picker begins picking a Pending order and it leaves the Pending queue", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await searchQueue(page, customerName);

  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await row.getByRole("button", { name: "Begin Picking" }).click();
  await expect(toasts(page).getByText(`Order ${order.number} is now in Picking.`)).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.goto("/queue/picking");
  await searchQueue(page, customerName);
  await expect(page.getByRole("row", { name: new RegExp(order.number) })).toContainText(
    "E2E PICKER",
  );
});

test("a stale version shows a toast and the queue refetches", async ({ page }) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await searchQueue(page, customerName);
  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await expect(row).toBeVisible();

  // Another station moves the order just before this click reaches the server. Done in the route
  // handler so no refetch can slip in between and remove the row first.
  await page.route("**/rpc/orders/beginPicking", async (route) => {
    const moved = await page.request.post(`/api/v1/orders/${order.id}/begin-picking`, {
      data: { expectedVersion: order.version },
    });
    expect(moved.ok()).toBe(true);
    await route.continue();
  });

  await row.getByRole("button", { name: "Begin Picking" }).click();
  await expect(toasts(page).getByText(/This order changed since you loaded it/)).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("a Packer sees the Pending queue without Begin Picking", async ({ page }) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName });
  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/pending");
  await searchQueue(page, customerName);
  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Begin Picking" })).toHaveCount(0);
});
