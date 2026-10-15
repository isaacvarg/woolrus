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

test("a user deactivated while the order event stream is open is cut off at the next heartbeat", async ({
  page,
}) => {
  test.slow(); // The server re-checks the session every 25 s.
  const picker = await signInAs(page, ["PICKER"]);
  await page.goto("/");

  // Reads the raw stream (EventSource would quietly reconnect). The first chunk proves it's open.
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/events/orders");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    (window as unknown as { stream: typeof reader }).stream = reader;
    await reader.read();
    return response.status;
  });
  expect(status).toBe(200);
  await db.user.update({ where: { id: picker.id }, data: { active: false } });

  const ended = page.evaluate(async () => {
    const reader = (window as unknown as { stream: ReadableStreamDefaultReader }).stream;
    while (!(await reader.read()).done) {}
    return "ended";
  });
  expect(await ended).toBe("ended");
});
