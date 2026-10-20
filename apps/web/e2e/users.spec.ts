import { type BrowserContext, expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { findUserRow } from "./support/users";

const db = createDb();

// Every e2e run leaves its users behind, so a local dev database lists thousands: each render of
// /users in dev mode (first load, and every refetch after a change) can take several seconds. CI
// starts empty.
const slowRender = { timeout: 30_000 };

/** Signs a second browser in as a fresh user with a unique name, so its row is easy to find. */
async function signInOther(context: BrowserContext, roles: Parameters<typeof signInAs>[1]) {
  const page = await context.newPage();
  const user = await signInAs(page, roles);
  const name = `E2E ${crypto.randomUUID().slice(0, 8)}`;
  await db.user.update({ where: { id: user.id }, data: { name } });
  return { ...user, name, page };
}

/** The session token as a bearer token: the same Better Auth session the cookie carries. */
async function bearerToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name.endsWith("session_token"));
  if (!cookie) throw new Error("no session cookie");
  return decodeURIComponent(cookie.value);
}

test("only users who manage users see the Users nav entry and page", async ({ page }) => {
  await signInAs(page, ["PACKER"]);
  await page.goto("/");
  await openNav(page);
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await page.goto("/users");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
});

test("an admin changes a user's roles, deactivates them and reactivates them", async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // See slowRender: every re-render of a local table of thousands of users is slow.
  await signInAs(page, ["ADMIN"]);
  const other = await browser.newContext();
  const ana = await signInOther(other, ["PICKER"]);
  const token = await bearerToken(other);
  // A cookie-less client: a refused bearer token makes Better Auth clear the session cookie, which
  // through page.request would sign the admin out.
  const asBearer = { headers: { Authorization: `Bearer ${token}` } };
  expect((await other.request.get("/api/v1/me")).status()).toBe(200);
  expect((await request.get("/api/v1/me", asBearer)).status()).toBe(200);

  await page.goto("/");
  await openNav(page);
  await page.getByRole("link", { name: "Users" }).click();
  const row = await findUserRow(page, ana.name);
  await expect(row).toContainText("Picker", slowRender);
  await expect(row).toContainText("Active", slowRender);

  await row.getByRole("button", { name: `Actions for ${ana.name}` }).click();
  await page.getByRole("menuitem", { name: "Edit roles" }).click();
  const roles = page.getByRole("dialog", { name: `Roles for ${ana.name}` });
  await roles.getByText("Packer").click();
  await roles.getByText("Picker").click();
  await roles.getByRole("button", { name: "Save" }).click();
  await expect(roles).toBeHidden(slowRender);
  await expect(row).toContainText("Packer", slowRender);
  await expect(row).not.toContainText("Picker", slowRender);

  await row.getByRole("button", { name: `Actions for ${ana.name}` }).click();
  await page.getByRole("menuitem", { name: "Deactivate" }).click();
  const confirm = page.getByRole("dialog", { name: `Deactivate ${ana.name}?` });
  await confirm.getByRole("button", { name: "Deactivate" }).click();
  await expect(confirm).toBeHidden(slowRender);
  await expect(row).toContainText("Deactivated", slowRender);

  // Signed out everywhere at once: the cookie and the bearer token both stop working.
  expect((await other.request.get("/api/v1/me")).status()).toBe(401);
  expect((await request.get("/api/v1/me", asBearer)).status()).toBe(401);
  await ana.page.goto("/");
  await expect(ana.page).toHaveURL(/\/sign-in/);

  await row.getByRole("button", { name: `Actions for ${ana.name}` }).click();
  await page.getByRole("menuitem", { name: "Reactivate" }).click();
  await expect(row).not.toContainText("Deactivated", slowRender);
  await other.close();
});

test("an admin can't edit themselves from the table", async ({ page }) => {
  const admin = await signInAs(page, ["ADMIN"]);
  const name = `E2E ${crypto.randomUUID().slice(0, 8)}`;
  await db.user.update({ where: { id: admin.id }, data: { name } });
  await page.goto("/users");
  const row = await findUserRow(page, name);
  await expect(row).toBeVisible(slowRender);
  await expect(row.getByRole("button", { name: `Actions for ${name}` })).toHaveCount(0);
});
