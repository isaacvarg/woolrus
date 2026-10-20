import { expect, type Page, test } from "@playwright/test";
import { signInAs, signInAsUser } from "./support/auth";
import { openNav } from "./support/nav";

async function choose(page: Page, menu: string, item: string) {
  await openNav(page);
  await page.getByRole("button", { name: menu }).click();
  await page.getByRole("menuitemradio", { name: item }).click();
}

test("language and theme are saved on the user and follow them to a new session", async ({
  page,
  browser,
}) => {
  const user = await signInAs(page, ["PICKER"]);
  await page.goto("/");
  await openNav(page);
  await expect(page.getByRole("navigation").getByText(user.email)).toBeVisible();

  await choose(page, "Preferences", "Español");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await choose(page, "Preferencias", "Oscuro");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Another device: no cookies but a new session for the same user.
  const other = await (await browser.newContext()).newPage();
  await signInAsUser(other, user.id);
  await other.goto("/");
  await expect(other.locator("html")).toHaveAttribute("lang", "es");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");

  // Log out keeps the language on the sign-in page.
  await openNav(other);
  await other.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(other).toHaveURL(/\/sign-in/);
  await expect(other.locator("html")).toHaveAttribute("lang", "es");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.goto("/");
  await expect(other).toHaveURL(/\/sign-in/);
});

test("a collapsed sidebar stays collapsed after a reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tablet", "the sidebar only pins open on desktop");
  await signInAs(page, ["PACKER"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByLabel("Open menu")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Open menu")).toBeVisible();

  await page.getByLabel("Open menu").click();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByLabel("Open menu")).toBeHidden();
});

test("saving preferences needs a signed-in user", async ({ request }) => {
  const response = await request.patch("/api/v1/me/preferences", { data: { locale: "es" } });
  expect(response.status()).toBe(401);
});
