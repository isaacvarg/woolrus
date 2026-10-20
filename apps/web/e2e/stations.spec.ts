import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";

const db = createDb();

test("an admin makes this device a station, and revoking it sends the device to sign-in", async ({
  page,
  browser,
}) => {
  const admin = await signInAs(page, ["ADMIN"]);
  const name = `E2E Pack ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto("/stations");
  await page.getByRole("button", { name: "Make this device a station" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Make it a station" }).click();

  // The lock screen, full screen, with the station's name.
  await expect(page).toHaveURL(/\/station$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // The token is only in an httpOnly cookie (StationSummary has no field for it; core tests check
  // the body), and the admin's own session on the device is over.
  const cookie = (await page.context().cookies()).find((c) => c.name === "woolrus_station");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 399 * 86_400);
  expect(await db.session.count({ where: { userId: admin.id } })).toBe(0);

  // Locked: app pages go to the lock screen and the API says so; the station itself answers.
  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/station$/);
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(401);
  expect(await me.json()).toMatchObject({ data: { messageKey: "errors.station.locked" } });
  const status = await page.request.get("/api/v1/station");
  expect(await status.json()).toMatchObject({ name });

  // Another admin, on a desktop, revokes it.
  const desk = await (await browser.newContext()).newPage();
  await signInAs(desk, ["ADMIN"]);
  await desk.goto("/stations");
  const row = desk.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await desk.getByRole("menuitem", { name: "Revoke" }).click();
  await desk.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");

  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(
    (await page.context().cookies()).find((c) => c.name === "woolrus_station"),
  ).toBeUndefined();
});

test("an admin renames a station", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  const station = await db.station.create({
    data: { name: `E2E Old ${crypto.randomUUID().slice(0, 8)}`, tokenHash: crypto.randomUUID() },
  });
  const renamed = `E2E New ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto("/stations");
  const row = page.getByRole("row").filter({ hasText: station.name });
  await row.getByRole("button", { name: `Actions for ${station.name}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(renamed);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row").filter({ hasText: renamed })).toBeVisible();
});

test("stations are admin-only", async ({ page, request }) => {
  await signInAs(page, ["PACKER"]);
  for (const response of await Promise.all([
    page.request.get("/api/v1/stations"),
    page.request.post("/api/v1/stations", { data: { name: "Nope" } }),
  ])) {
    expect(response.status()).toBe(403);
  }
  expect((await request.get("/api/v1/station")).status()).toBe(401);
});
