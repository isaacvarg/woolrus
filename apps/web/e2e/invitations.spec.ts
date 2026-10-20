import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";

const db = createDb();
// See users.spec.ts: /users renders slowly on a local database full of e2e users.
const slowRender = { timeout: 30_000 };

/** Follows the magic link for `email` the way the invitee would, reading its token from the DB. */
async function signInWithMagicLink(page: Page, email: string) {
  const response = await page.request.post("/api/auth/sign-in/magic-link", {
    data: { email, callbackURL: "/" },
  });
  expect(response.ok()).toBe(true);
  const verification = await db.verification.findFirstOrThrow({
    where: { identifier: { startsWith: "magic-link:" }, value: { contains: `"${email}"` } },
    orderBy: { createdAt: "desc" },
  });
  const token = verification.identifier.slice("magic-link:".length);
  await page.goto(`/api/auth/magic-link/verify?token=${token}&callbackURL=/`);
}

test("an admin invites a user, who signs in with exactly the invited roles", async ({
  page,
  browser,
}) => {
  test.slow();
  await signInAs(page, ["ADMIN"]);
  const email = `invitee-${crypto.randomUUID()}@example.test`;

  await page.goto("/users?tab=invitations");
  await page.getByRole("button", { name: "Invite user" }).click(slowRender);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email.toUpperCase());
  await dialog.getByText("Packer").click();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible(slowRender);
  const row = page.getByRole("row", { name: new RegExp(email) });
  await expect(row.getByText("Pending")).toBeVisible();

  // The emailed link pre-fills the sign-in form.
  const invitee = await (await browser.newContext()).newPage();
  await invitee.goto(`/sign-in?email=${encodeURIComponent(email)}`);
  await expect(invitee.getByLabel("Email")).toHaveValue(email);

  await signInWithMagicLink(invitee, email);
  await expect(invitee).not.toHaveURL(/sign-in/);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  expect(user.roles).toEqual(["PACKER"]);

  await page.reload();
  await expect(row.getByText("Accepted")).toBeVisible(slowRender);
});

test("a revoked invitation can't create an account", async ({ page, browser }) => {
  await signInAs(page, ["ADMIN"]);
  const email = `revoked-${crypto.randomUUID()}@example.test`;

  await page.goto("/users?tab=invitations");
  await page.getByRole("button", { name: "Invite user" }).click(slowRender);
  await page.getByRole("dialog").getByLabel("Email").fill(email);
  await page.getByRole("dialog").getByText("QA").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send invitation" }).click();
  const row = page.getByRole("row", { name: new RegExp(email) });
  await row.getByRole("button", { name: `Actions for ${email}` }).click(slowRender);
  await page.getByRole("menuitem", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByText("Revoked")).toBeVisible(slowRender);

  const invitee = await (await browser.newContext()).newPage();
  await signInWithMagicLink(invitee, email);
  await expect(invitee).toHaveURL(/sign-in|error/);
  expect(await db.user.count({ where: { email } })).toBe(0);
});

test("invitations are admin-only", async ({ request, page }) => {
  await signInAs(page, ["PICKER"]);
  const response = await page.request.get("/api/v1/invitations");
  expect(response.status()).toBe(403);
  expect((await request.get("/api/v1/invitations")).status()).toBe(401);
});
