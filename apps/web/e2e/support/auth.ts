import type { Page } from "@playwright/test";
import { createDb, type Role } from "@woolrus/db";

const db = createDb();

/**
 * Signs `page`'s browser context in as a fresh user with `roles`, through the real magic-link
 * flow. The user is created first, so the invite-only hook (which only guards new accounts) and
 * ADMIN_EMAILS don't apply. The link is never emailed in dev, so the token is read from the
 * verification table, where Better Auth stores it as `magic-link:<token>`.
 */
export async function signInAs(page: Page, roles: Role[]): Promise<{ id: string; email: string }> {
  const email = `e2e-${crypto.randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { name: `E2E ${roles.join("+")}`, email, emailVerified: true, roles },
  });

  const response = await page.request.post("/api/auth/sign-in/magic-link", {
    data: { email, callbackURL: "/" },
  });
  if (!response.ok()) throw new Error(`magic link request failed: ${response.status()}`);

  const verification = await db.verification.findFirstOrThrow({
    where: { identifier: { startsWith: "magic-link:" }, value: { contains: `"${email}"` } },
    orderBy: { createdAt: "desc" },
  });
  const token = verification.identifier.slice("magic-link:".length);
  await page.goto(`/api/auth/magic-link/verify?token=${token}&callbackURL=/`);

  return { id: user.id, email };
}
