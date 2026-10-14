import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { requestMagicLink, signInAs } from "./support/auth";

const db = createDb();

test("signInAs opens a session with the given roles", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/boxes$/);
  await expect(page.getByRole("heading", { name: "Boxes" })).toBeVisible();
});

test("a magic link requested at sign-in opens a session", async ({ page }) => {
  // The only test that goes through /sign-in/magic-link, which production builds rate limit.
  await requestMagicLink(page, ["PICKER"]);
  await page.goto("/boxes");
  await expect(page.getByRole("heading", { name: "Boxes" })).toBeVisible();
});

test("two users can be signed in side by side", async ({ browser }) => {
  const admin = await browser.newContext();
  const picker = await browser.newContext();
  const adminMe = await signInAs(await admin.newPage(), ["ADMIN"]);
  const pickerMe = await signInAs(await picker.newPage(), ["PICKER"]);

  const adminRoles = await (await admin.request.get("/api/v1/me")).json();
  const pickerRoles = await (await picker.request.get("/api/v1/me")).json();
  expect(adminRoles).toMatchObject({ email: adminMe.email, roles: ["ADMIN"] });
  expect(pickerRoles).toMatchObject({ email: pickerMe.email, roles: ["PICKER"] });

  await admin.close();
  await picker.close();
});

test("a deactivated user keeps no access, in the API or the pages", async ({ page }) => {
  const admin = await signInAs(page, ["ADMIN"]);
  await db.user.update({ where: { id: admin.id }, data: { active: false } });

  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
  await page.goto("/settings");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
});
