import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";

const db = createDb();

/**
 * Asks for a magic link and follows it the way the recipient would, with the sign-in page as the
 * error callback. The token is read from the verification table: Better Auth stores it before
 * our sender decides whether to email it, so this also stands in for a link that leaked.
 */
async function followMagicLink(page: Page, email: string) {
  const response = await page.request.post("/api/auth/sign-in/magic-link", {
    data: { email, callbackURL: "/", errorCallbackURL: "/sign-in" },
  });
  expect(response.ok()).toBe(true);
  const verification = await db.verification.findFirstOrThrow({
    where: { identifier: { startsWith: "magic-link:" }, value: { contains: `"${email}"` } },
    orderBy: { createdAt: "desc" },
  });
  const token = verification.identifier.slice("magic-link:".length);
  await page.goto(
    `/api/auth/magic-link/verify?token=${token}&callbackURL=/&errorCallbackURL=/sign-in`,
  );
}

test("a deactivated user can't sign in and is told why", async ({ page }) => {
  const email = `deactivated-${crypto.randomUUID()}@example.test`;
  await db.user.create({
    data: { name: "Gone", email, emailVerified: true, roles: ["PICKER"], active: false },
  });

  await followMagicLink(page, email);

  await expect(page).toHaveURL(/\/sign-in\?error=/);
  // By text: Next's route announcer is also a role="alert".
  await expect(
    page.getByText("Your account is deactivated. Ask an admin to reactivate it."),
  ).toBeVisible();
  expect(await db.session.count({ where: { user: { email } } })).toBe(0);
});

test("an email with no invitation can't create an account (SRS §7.1 #3)", async ({ page }) => {
  const email = `stranger-${crypto.randomUUID()}@example.test`;

  await followMagicLink(page, email);

  await expect(page).toHaveURL(/\/sign-in\?error=/);
  await expect(page.getByText("Sign-in didn't work. Try again.")).toBeVisible();
  expect(await db.user.count({ where: { email } })).toBe(0);
});

test("the page answers the same whether or not anything was sent", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(`nobody-${crypto.randomUUID()}@example.test`);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email for a sign-in link.");
});

test("the sign-in page follows the language cookie and hides unconfigured providers", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "locale", value: "es", url: baseURL ?? "" }]);
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Enviarme un enlace" })).toBeVisible();
  await expect(page.getByLabel("Correo")).toBeVisible();
  // Dev and CI configure no OAuth app.
  await expect(page.getByRole("button", { name: /Discord/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0);
});
