import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";

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
