import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";

test("signInAs opens a session with the given roles", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/boxes$/);
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
