import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";

test("a nav link click closes the tablet drawer so the new page takes clicks", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/orders");

  // On desktop the nav is always open and there is no menu button.
  const menu = page.getByLabel("Open menu");
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation").getByRole("link", { name: "Boxes" }).click();

  await expect(page).toHaveURL(/\/boxes$/);
  await expect(page.locator("#nav")).not.toBeChecked();
  // A trial click fails if anything, such as the drawer overlay, would intercept it.
  await page
    .getByRole("heading", { name: "Boxes", level: 1 })
    .click({ trial: true, timeout: 2_000 });
});

test("the app name leads home; tools and configs sit under their own headings", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await openNav(page);
  const nav = page.getByRole("navigation");
  await expect(nav.getByText("Tools", { exact: true })).toBeVisible();
  await expect(nav.getByText("Configs", { exact: true })).toBeVisible();
  // Sync status sits at the bottom, below every link.
  const sync = nav.getByRole("status");
  const lastLink = nav.getByRole("link", { name: "Sync" });
  await expect(sync).toBeVisible();
  expect((await sync.boundingBox())?.y).toBeGreaterThan((await lastLink.boundingBox())?.y ?? 0);

  await nav.getByRole("link", { name: "Woolrus" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
});

test("a picker's nav shows only the links a picker may open", async ({ page }) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/");
  await openNav(page);
  const nav = page.getByRole("navigation");
  // Lot lookup is open to everyone with order.read, so Tools shows; Users is admin-only.
  await expect(nav.getByText("Tools", { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Lot lookup" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Boxes" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);
});
