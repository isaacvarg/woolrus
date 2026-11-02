import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";

// Manifests (SPEC-shipping "Manifests"): the screen and its PDF route are for people who can ship.
// Creating a manifest against a provider is covered by the core tests with the fake provider.

const NO_SUCH_MANIFEST = "0199e6a0-0000-7000-8000-00000000dead";

test("a shipper opens Manifests from the nav and sees a day with nothing to manifest", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  await signInAs(page, ["SHIPPER"]);
  await page.goto("/orders");
  await page.getByRole("navigation").getByRole("link", { name: "Manifests" }).click();

  await expect(page).toHaveURL(/\/manifests$/);
  await expect(page.getByRole("heading", { name: "Manifests", level: 1 })).toBeVisible();
  await page.getByLabel("Ship date").fill("2020-01-02");
  await expect(page.getByText("No shipped labels or manifests for this day.")).toBeVisible();
});

test("a picker has no Manifests link, no page and no PDF", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  await signInAs(page, ["PICKER"]);
  await page.goto("/orders");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Manifests" })).toHaveCount(
    0,
  );

  await page.goto("/manifests");
  await expect(page.getByRole("alert")).toContainText("You don't have permission to do that.");
  expect((await page.request.get(`/api/manifests/${NO_SUCH_MANIFEST}.pdf`)).status()).toBe(403);
});

test("the manifest PDF route answers 404 to a shipper for an unknown or malformed id", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  await signInAs(page, ["SHIPPER"]);
  expect((await page.request.get(`/api/manifests/${NO_SUCH_MANIFEST}.pdf`)).status()).toBe(404);
  expect((await page.request.get("/api/manifests/not-a-uuid.pdf")).status()).toBe(404);
});

test("the manifest PDF route needs a session", async ({ request }) => {
  expect((await request.get(`/api/manifests/${NO_SUCH_MANIFEST}.pdf`)).status()).toBe(401);
});
