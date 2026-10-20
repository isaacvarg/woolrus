import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";

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
