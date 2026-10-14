import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";

/** On tablet width the nav is a drawer behind the menu button. */
async function openNav(page: Page) {
  const menu = page.getByLabel("Open menu");
  if (await menu.isVisible()) await menu.click();
}

// Every test here shares the one settings row with the other project running in parallel. The form
// saves only the fields it changed, so each project edits its own field.

test("an admin saves general settings and they persist after a reload", async ({ page }, info) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const label = info.project.name === "desktop" ? "Sync interval" : "Station idle lock";
  const field = page.getByLabel(label, { exact: false });
  const current = Number(await field.inputValue());
  const next = current === 7 ? 8 : 7;

  await field.fill(String(next));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved.");

  await page.reload();
  await expect(page.getByLabel(label, { exact: false })).toHaveValue(String(next));
});

test("invalid input shows the field-level message next to the field", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const shipFrom = page.getByRole("group", { name: "Ship-from address" });

  await shipFrom.getByLabel("Contact name").fill("Shipping Dept");
  await shipFrom.getByLabel("Phone").fill("555-123-4567");
  await shipFrom.getByLabel("Address line 1").fill("1 Warehouse Way");
  await shipFrom.getByLabel("City").fill("Austin");
  await shipFrom.getByLabel("State").fill("Texas");
  await shipFrom.getByLabel("ZIP code").fill("78701");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("alert").first()).toBeVisible();
  const state = shipFrom.getByRole("textbox", { name: "State" });
  await expect(state).toHaveAttribute("aria-invalid", "true");
  await expect(shipFrom.getByText("Use the 2-letter state code, e.g. TX.")).toBeVisible();
});

test("a Picker has no Settings link and is refused at /settings", async ({ page }) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(page.getByRole("link", { name: "Boxes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("an admin sees the Settings link", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await openNav(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});
