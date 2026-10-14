import { expect, test } from "@playwright/test";

test("health check reports the database", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ checks: { database: "ok" } });
});

test("signed-out visitors land on sign-in", async ({ page }) => {
  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("button", { name: "Email me a link" })).toBeVisible();
});

test("the API refuses anonymous calls with a translatable error", async ({ request }) => {
  const response = await request.get("/api/v1/boxes");
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ data: { messageKey: "errors.unauthenticated" } });
});
