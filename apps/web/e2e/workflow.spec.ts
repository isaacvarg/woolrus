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

// Order detail (/orders/[id]).

const historyPanel = (page: Page) => page.getByRole("region", { name: "History" });

test("the detail page shows the header, read-only lines and the history", async ({ page }) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, priority: 1, quantity: 3, rushOrderLine: true });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);

  await expect(page.getByRole("heading", { name: `Order #${order.number}` })).toBeVisible();
  await expect(page.getByText(customerName)).toBeVisible();
  await expect(page.getByText("High", { exact: true })).toBeVisible();

  const lines = page.getByRole("table", { name: "Items" });
  await expect(lines.getByRole("row", { name: /E2E item/ })).toContainText("3");
  await expect(lines.getByRole("row", { name: /E2E Rush Order/ })).toContainText(
    "Not handled on the floor",
  );

  await page.getByRole("button", { name: "Begin Picking" }).click();
  await expect(toasts(page).getByText(`Order ${order.number} is now in Picking.`)).toBeVisible();
  await expect(page.getByText("Claimed by E2E PICKER")).toBeVisible();
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("Pending → Picking");
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("E2E PICKER");
});

test("a completion refused by its gate shows what's missing", async ({ page }) => {
  const order = await createOrder();
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Begin Picking" }).click();
  await page.getByRole("button", { name: "Complete Picking" }).click();

  const refused = page.getByRole("alert").filter({ hasText: "This stage isn't finished yet." });
  await expect(refused.getByRole("listitem")).toHaveText(["E2E item hasn't been picked."]);
  await expect(page.getByTestId("order-status")).toHaveText("Picking");
});

test("a second picker sees the claim and takes the order over after confirming", async ({
  page,
  browser,
}) => {
  const order = await createOrder();
  await signInAs(page, ["PICKER"]);
  const begun = await page.request.post(`/api/v1/orders/${order.id}/begin-picking`, {
    data: { expectedVersion: order.version },
  });
  expect(begun.ok()).toBe(true);

  const other = await (await browser.newContext()).newPage();
  try {
    await signInAs(other, ["PICKER", "PACKER"]);
    await other.goto(`/orders/${order.id}`);
    await expect(other.getByText("Claimed by E2E PICKER")).toBeVisible();
    await expect(other.getByRole("button", { name: "Complete Picking" })).toHaveCount(0);

    await other.getByRole("button", { name: "Take over" }).click();
    const dialog = other.getByRole("dialog", { name: "Take over this order?" });
    await expect(dialog).toContainText("E2E PICKER is working on this order.");
    await dialog.getByRole("button", { name: "Take over" }).click();

    await expect(toasts(other).getByText(`You took over order ${order.number}.`)).toBeVisible();
    await expect(other.getByText("Claimed by E2E PICKER+PACKER")).toBeVisible();
    await expect(other.getByRole("button", { name: "Complete Picking" })).toBeVisible();
    await expect(historyPanel(other).getByRole("listitem").first()).toContainText(
      "Took over from E2E PICKER",
    );
  } finally {
    await other.context().close();
  }
});

test("an order put on hold appears in On Hold and resumes to its stage", async ({ page }) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Begin Picking" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Picking");

  await page.getByRole("button", { name: "Hold" }).click();
  const dialog = page.getByRole("dialog", { name: "Put this order on hold" });
  // A reason is required.
  await dialog.getByRole("button", { name: "Hold" }).click();
  await expect(dialog.getByText("This field is required.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Waiting on stock");
  await dialog.getByRole("button", { name: "Hold" }).click();
  await expect(toasts(page).getByText(`Order ${order.number} is now in On Hold.`)).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("On Hold");
  await expect(page.getByText("Waiting on stock").first()).toBeVisible();

  await page.goto("/queue/on-hold");
  await searchQueue(page, customerName);
  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await expect(row).toContainText("Waiting on stock");
  await row.getByRole("link", { name: `#${order.number}` }).click();

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(toasts(page).getByText(`Order ${order.number} is now in Picking.`)).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("Picking");
});

test("an admin cancels an order with a reason; a picker can't", async ({ page, browser }) => {
  const order = await createOrder();
  const picker = await (await browser.newContext()).newPage();
  try {
    await signInAs(picker, ["PICKER"]);
    await picker.goto(`/orders/${order.id}`);
    await expect(picker.getByRole("button", { name: "Begin Picking" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "Force status" })).toHaveCount(0);
  } finally {
    await picker.context().close();
  }

  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Cancel order" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this order" });
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Customer asked");
  await dialog.getByRole("button", { name: "Cancel order" }).click();

  await expect(toasts(page).getByText(`Order ${order.number} is now in Cancelled.`)).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText("Cancelled");
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("Customer asked");
});

test("an admin forces an order to another status with a reason", async ({ page }) => {
  const order = await createOrder();
  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Force status" }).click();
  const dialog = page.getByRole("dialog", { name: "Force status" });
  // React Aria keeps the input visually hidden; people tap the label.
  await dialog.getByText("QA", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "QA" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Packed by hand");
  await dialog.getByRole("button", { name: "Force status" }).click();

  await expect(page.getByTestId("order-status")).toHaveText("QA");
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("Pending → QA");
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("Packed by hand");
});

/** The All Orders rows for one test's orders, in table order. */
const orderRows = (page: Page, tag: string) => page.getByRole("row").filter({ hasText: tag });

test("All Orders searches, filters by status in the URL, and opens a row", async ({ page }) => {
  const tag = `E2E ${crypto.randomUUID()}`;
  await createOrder({ customerName: `${tag} Alpha` });
  const packing = await createOrder({ customerName: `${tag} Bravo`, status: "PACKING" });
  await signInAs(page, ["PICKER"]);
  await page.goto("/orders");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(tag);
  // Both are on the first page anyway (newest first); the URL shows the search was applied.
  await expect(page).toHaveURL(/search=/);
  await expect(orderRows(page, tag)).toHaveCount(2);

  await page.getByRole("button", { name: "Packing", exact: true }).click();
  await expect(orderRows(page, tag)).toHaveCount(1);
  await expect(page).toHaveURL(/statuses=PACKING/);

  // The URL carries the whole view: a reload (or a shared link) shows the same rows.
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search orders" })).toHaveValue(tag);
  await expect(page.getByRole("button", { name: "Packing", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(orderRows(page, tag)).toHaveCount(1);
  await expect(orderRows(page, tag)).toContainText("Packing");

  await orderRows(page, tag).getByRole("cell").nth(1).click();
  await expect(page).toHaveURL(`/orders/${packing.id}`);
  await page.goBack();
  await expect(orderRows(page, tag)).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search orders" })).toHaveValue(tag);
  await expect(orderRows(page, tag)).toHaveCount(2);
});

test("All Orders sorts by a column and pages through the results", async ({ page }) => {
  const tag = `E2E ${crypto.randomUUID()}`;
  const day = 24 * 60 * 60_000;
  // Ordered newest first by default: Charlie, Bravo, Alpha.
  for (const [i, name] of ["Alpha", "Bravo", "Charlie"].entries()) {
    await createOrder({
      customerName: `${tag} ${name}`,
      orderedAt: new Date(Date.now() - (3 - i) * day),
    });
  }
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders?search=${encodeURIComponent(tag)}`);
  await expect(orderRows(page, tag)).toHaveText([/Charlie/, /Bravo/, /Alpha/]);

  const customer = page.getByRole("columnheader", { name: "Customer" });
  await customer.getByRole("button").click();
  await expect(customer).toHaveAttribute("aria-sort", "ascending");
  await expect(orderRows(page, tag)).toHaveText([/Alpha/, /Bravo/, /Charlie/]);
  await customer.getByRole("button").click();
  await expect(customer).toHaveAttribute("aria-sort", "descending");
  await expect(orderRows(page, tag)).toHaveText([/Charlie/, /Bravo/, /Alpha/]);
  await expect(page).toHaveURL(/sort=customer&dir=desc/);

  await page.goto(`/orders?search=${encodeURIComponent(tag)}&sort=customer&dir=asc&pageSize=2`);
  await expect(orderRows(page, tag)).toHaveText([/Alpha/, /Bravo/]);
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(orderRows(page, tag)).toHaveText([/Charlie/]);
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
});
