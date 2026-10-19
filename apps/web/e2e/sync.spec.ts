import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import {
  createStoreOrder,
  deleteStoreOrder,
  editStoreOrderAddress,
  importedOrder,
  savedWebhookSecret,
  signedOrderUpdated,
  startPicking,
} from "./support/woo";

/** On tablet width the nav is a drawer behind the menu button. */
async function openNav(page: Page) {
  const menu = page.getByLabel("Open menu");
  if (await menu.isVisible()) await menu.click();
}

const syncStatus = (page: Page) =>
  page.getByRole("navigation").getByRole("status").filter({ hasText: /sync/i });

test("the sync API refuses anonymous calls", async ({ request }) => {
  const response = await request.get("/api/v1/sync/status");
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ data: { messageKey: "errors.unauthenticated" } });
});

test("a Picker sees when sync last ran but has no Sync link and is refused at /sync", async ({
  page,
}) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(syncStatus(page)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sync", exact: true })).toHaveCount(0);

  await page.goto("/sync");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync orders now" })).toHaveCount(0);
  expect((await page.request.get("/api/v1/sync/runs")).status()).toBe(403);
});

test("an admin queues a products sync from the Sync page and it shows in the log", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(page.getByRole("link", { name: "Sync", exact: true })).toBeVisible();
  await page.goto("/sync");
  await expect(page.getByRole("heading", { name: "Sync", level: 1 })).toBeVisible();

  const newestProductsRun = async () => {
    const page1 = await (await page.request.get("/api/v1/sync/runs?type=PRODUCTS&limit=1")).json();
    return (page1.rows[0]?.id as string | undefined) ?? null;
  };
  const before = await newestProductsRun();
  await page.getByRole("button", { name: "Sync products now" }).click();
  await expect(page.getByText("Sync queued.", { exact: false })).toBeVisible();

  // The worker picks the job up; without one (CI) the run never starts.
  test.skip(!process.env.E2E_DEV_STACK, "needs the worker and the dev store (E2E_DEV_STACK=1)");
  await expect.poll(newestProductsRun, { timeout: 30_000 }).not.toBe(before);
  const log = page.getByRole("table", { name: "Sync log" });
  await expect(log.getByRole("row").nth(1)).toContainText("Products");
});

// SC 13: the journey against the dev store (`pnpm stack:up`, `pnpm dev` with the worker). CI has
// neither, so these run only with E2E_DEV_STACK=1.
test.describe("against the dev store", () => {
  test.skip(!process.env.E2E_DEV_STACK, "needs the worker and the dev store (E2E_DEV_STACK=1)");
  // The worker takes webhook jobs one at a time, every 2 s; parallel projects queue behind each other.
  test.slow();
  // One store order per test; the projects run in parallel, so names are unique.
  const storeOrders: number[] = [];
  test.afterEach(async () => {
    for (const id of storeOrders.splice(0)) await deleteStoreOrder(id);
  });

  test("Test connection, then Sync orders now brings the store's new order into Pending", async ({
    page,
  }) => {
    const lastName = `Sync ${crypto.randomUUID().slice(0, 8)}`;
    const storeOrder = await createStoreOrder(lastName);
    storeOrders.push(storeOrder.id);
    await signInAs(page, ["ADMIN"]);

    await page.goto("/settings");
    const woo = page.getByRole("region", { name: "WooCommerce" });
    await woo.getByRole("button", { name: "Test connection" }).click();
    await expect(woo.getByText(/^Connected\./)).toBeVisible({ timeout: 15_000 });

    await page.goto("/sync");
    await page.getByRole("button", { name: "Sync orders now" }).click();
    await expect(page.getByText("Sync queued.", { exact: false })).toBeVisible();
    // The store's own webhook may get there first; either way the order arrives.
    await importedOrder(storeOrder.id);

    await page.goto("/queue/pending");
    await page.getByRole("searchbox", { name: "Search orders" }).fill(lastName);
    await expect(page.getByRole("row", { name: new RegExp(lastName) })).toBeVisible();
    await openNav(page);
    await expect(syncStatus(page)).toHaveText(/^Synced (just now|\d+ (second|minute)s? ago)/, {
      timeout: 30_000,
    });
  });

  test("a signed webhook for an order edited in the store after picking began shows the banner", async ({
    page,
  }) => {
    const secret = await savedWebhookSecret();
    test.skip(!secret, "no webhook secret saved in Settings");
    const lastName = `Hook ${crypto.randomUUID().slice(0, 8)}`;
    const storeOrder = await createStoreOrder(lastName);
    storeOrders.push(storeOrder.id);
    await signInAs(page, ["ADMIN"]);

    // Import it with a signed order.created-style delivery, then start picking it here.
    const created = await page.request.post(
      "/api/webhooks/woocommerce",
      signedOrderUpdated(storeOrder, secret ?? ""),
    );
    expect(created.status()).toBe(200);
    const order = await importedOrder(storeOrder.id);
    await startPicking(order.id);

    const edited = await editStoreOrderAddress(storeOrder.id, lastName);
    const delivery = await page.request.post(
      "/api/webhooks/woocommerce",
      signedOrderUpdated(edited, secret ?? ""),
    );
    expect(delivery.status()).toBe(200);

    await page.goto(`/orders/${order.id}`);
    const banner = page.getByRole("region", { name: "Changed in the store" });
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText("99 New Street");
  });
});
