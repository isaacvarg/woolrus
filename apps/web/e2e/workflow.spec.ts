import { expect, type Page, test } from "@playwright/test";
import en from "@woolrus/i18n/messages/en.json" with { type: "json" };
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { deleteCreatedRules, trackRules } from "./support/priority-rules";
import { withSettingsLock } from "./support/settings-lock";

/** On tablet width the nav is a drawer behind the menu button. */
async function openNav(page: Page) {
  const menu = page.getByLabel("Open menu");
  if (await menu.isVisible()) await menu.click();
}

test.afterAll(async () => {
  await withSettingsLock(deleteCreatedRules);
  await deleteCreatedOrders();
});

const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

/**
 * Narrows a queue to one test's orders: every test uses its own customer name. Waits for the
 * searched page, so a row seen afterwards can't vanish when a late debounced search lands.
 */
async function searchQueue(page: Page, text: string) {
  const searched = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/orders/queue") &&
      (response.request().postData() ?? "").includes(text),
  );
  await page.getByRole("searchbox", { name: "Search orders" }).fill(text);
  await searched;
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
  // Admin: the only role that can set an SLA, and it reads queues like everyone else.
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    // Inside the lock: a priority rule change elsewhere would recompute this priority away.
    const order = await createOrder({
      customerName,
      priority: 2,
      quantity: 3,
      statusChangedAt: old,
    });
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

test("another browser's queue and order page update live when an order moves", async ({
  page,
  browser,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName });
  const watcher = await browser.newContext();
  try {
    const queue = await watcher.newPage();
    await signInAs(queue, ["PACKER"]);
    await queue.goto("/queue/pending");
    await searchQueue(queue, customerName);
    const watchedRow = queue.getByRole("row", { name: new RegExp(order.number) });
    await expect(watchedRow).toBeVisible();
    const detail = await watcher.newPage();
    await detail.goto(`/orders/${order.id}`);
    await expect(detail.getByTestId("order-status")).toHaveText("Pending");

    await signInAs(page, ["PICKER"]);
    await page.goto("/queue/pending");
    await searchQueue(page, customerName);
    await page
      .getByRole("row", { name: new RegExp(order.number) })
      .getByRole("button", { name: "Begin Picking" })
      .click();

    // Well inside the 30 s polling fallback, so only the live event can explain it.
    await expect(watchedRow).toHaveCount(0, { timeout: 10_000 });
    await expect(detail.getByTestId("order-status")).toHaveText("Picking", { timeout: 10_000 });
    await expect(detail.getByText("Claimed by E2E PICKER")).toBeVisible();
  } finally {
    await watcher.close();
  }
});

test("with the event stream down, the queue polls every 30 s until it reconnects", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName });
  await page.clock.install();
  await page.route("**/api/events/orders", (route) => route.abort());
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await searchQueue(page, customerName);
  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await expect(row).toBeVisible();

  const moved = await page.request.post(`/api/v1/orders/${order.id}/begin-picking`, {
    data: { expectedVersion: order.version },
  });
  expect(moved.ok()).toBe(true);
  await page.clock.runFor(25_000);
  await expect(row).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(row).toHaveCount(0);

  // Back online: it reconnects within the backoff and stops polling.
  await page.unroute("**/api/events/orders");
  const connected = page.waitForResponse("**/api/events/orders");
  await page.clock.runFor(60_000);
  expect((await connected).status()).toBe(200);
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
  await signInAs(page, ["PICKER"]);
  // In the lock while priority is checked: a priority rule change elsewhere would recompute it.
  const order = await withSettingsLock(async () => {
    const order = await createOrder({
      customerName,
      priority: 1,
      quantity: 3,
      rushOrderLine: true,
    });
    await page.goto(`/orders/${order.id}`);
    await expect(page.getByRole("heading", { name: `Order #${order.number}` })).toBeVisible();
    await expect(page.getByText(customerName)).toBeVisible();
    await expect(page.getByText("High", { exact: true })).toBeVisible();
    return order;
  });

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

// Priority rules (/settings/priority-rules). Rules are global and every change recomputes all open
// orders, so tests that change rules, or that check a priority set by hand, hold the settings lock.

const ruleRows = (page: Page, tag: string) =>
  page.getByRole("table", { name: "Priority rules" }).getByRole("row", { name: new RegExp(tag) });

test("an admin adds a priority rule and the Pending queue reorders", async ({ page }) => {
  const tag = trackRules(`E2E ${crypto.randomUUID()}`);
  const sku = `E2E-${crypto.randomUUID().slice(0, 8)}`;
  await createOrder({ customerName: `${tag} Older`, orderedAt: new Date(Date.now() - 3_600_000) });
  await createOrder({ customerName: `${tag} Newer`, sku });
  await signInAs(page, ["ADMIN"]);
  const queueRows = page.getByRole("row", { name: new RegExp(tag) });

  await withSettingsLock(async () => {
    try {
      await page.goto("/queue/pending");
      await searchQueue(page, tag);
      await expect(queueRows).toHaveText([/Older/, /Newer/]);

      await page.goto("/settings/priority-rules");
      await page.getByRole("button", { name: "Add rule" }).click();
      const dialog = page.getByRole("dialog", { name: "Add rule" });
      await dialog.getByRole("textbox", { name: "Name" }).fill(tag);
      await dialog.getByRole("textbox", { name: "SKU" }).fill(sku);
      await dialog.getByText("Urgent", { exact: true }).click();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(toasts(page).getByText(`Rule “${tag}” added.`, { exact: false })).toBeVisible();
      await expect(ruleRows(page, tag)).toContainText(`Has a line with SKU ${sku}`);
      await expect(ruleRows(page, tag)).toContainText("Urgent");

      await page.goto("/queue/pending");
      await searchQueue(page, tag);
      await expect(queueRows).toHaveText([/Newer/, /Older/]);
      await expect(queueRows.first().getByText("Urgent")).toBeVisible();

      await page.goto("/settings/priority-rules");
      await page.getByRole("button", { name: `Delete rule “${tag}”` }).click();
      await page
        .getByRole("dialog", { name: `Delete rule “${tag}”` })
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(ruleRows(page, tag)).toHaveCount(0);

      await page.goto("/queue/pending");
      await searchQueue(page, tag);
      await expect(queueRows).toHaveText([/Older/, /Newer/]);
    } finally {
      await deleteCreatedRules();
    }
  });
});

test("an admin edits, disables and reorders priority rules", async ({ page }) => {
  const tag = trackRules(`E2E ${crypto.randomUUID()}`);
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      for (const name of ["First", "Second"]) {
        const created = await page.request.post("/api/v1/priority-rules", {
          data: {
            idempotencyKey: crypto.randomUUID(),
            name: `${tag} ${name}`,
            condition: { type: "shippingMethod", contains: `${tag} ${name}` },
            priority: 1,
          },
        });
        expect(created.ok()).toBe(true);
      }
      await page.goto("/settings/priority-rules");
      await expect(ruleRows(page, tag)).toHaveText([/First/, /Second/]);

      await page.getByRole("button", { name: `Move “${tag} Second” up` }).click();
      await expect(ruleRows(page, tag)).toHaveText([/Second/, /First/]);

      await page.getByRole("button", { name: `Edit rule “${tag} First”` }).click();
      const dialog = page.getByRole("dialog", { name: `Edit rule “${tag} First”` });
      await dialog.getByText("Order age", { exact: true }).click();
      await dialog.getByRole("textbox", { name: /Ordered at least/ }).fill("72");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(ruleRows(page, tag).last()).toContainText("Ordered 72 hours ago or more");

      const toggle = page.getByRole("switch", { name: `Enable “${tag} Second”` });
      // React Aria's switch input is visually hidden, so it can't be clicked directly.
      await toggle.focus();
      await page.keyboard.press("Space");
      await expect(toasts(page).getByText(`Rule “${tag} Second” disabled.`)).toBeVisible();

      await page.reload();
      await expect(ruleRows(page, tag)).toHaveText([/Second/, /First/]);
      await expect(page.getByRole("switch", { name: `Enable “${tag} Second”` })).not.toBeChecked();
    } finally {
      await deleteCreatedRules();
    }
  });
});

test("a Picker has no Priority rules link and is refused at the page", async ({ page }) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/settings/priority-rules");
  await expect(page.getByRole("alert")).toHaveText(en.errors.forbidden);
  await expect(page.getByRole("table", { name: "Priority rules" })).toHaveCount(0);
  await openNav(page);
  await expect(page.getByRole("link", { name: "Priority rules" })).toHaveCount(0);
});
