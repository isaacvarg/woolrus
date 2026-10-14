import type { Page } from "@playwright/test";
import { createDb, type Role } from "@woolrus/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { testUtils } from "better-auth/plugins";

const db = createDb();

/**
 * A test-only Better Auth instance on the same database, secret and base URL as the app, with
 * Better Auth's testUtils plugin. It creates real sessions and signs their cookies exactly as the
 * app does, without going through the magic-link endpoints: production builds (CI) rate limit
 * those to 5 per minute, shared by every caller when no client IP is known. Never part of the
 * app's own auth config.
 */
const testAuth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),
  advanced: { database: { generateId: false } },
  plugins: [testUtils()],
});

/** Creates an active user with `roles`, as an admin would before they sign in for the first time. */
async function createUser(roles: Role[]): Promise<{ id: string; email: string }> {
  const email = `e2e-${crypto.randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { name: `E2E ${roles.join("+")}`, email, emailVerified: true, roles },
  });
  return { id: user.id, email };
}

/** Signs `page`'s browser context in as a fresh user with `roles`, with a real session cookie. */
export async function signInAs(page: Page, roles: Role[]): Promise<{ id: string; email: string }> {
  const user = await createUser(roles);
  const { test } = await testAuth.$context;
  await page.context().addCookies(await test.getCookies({ userId: user.id }));
  return user;
}

/**
 * Signs in through the full user flow: asks `/sign-in/magic-link` for a link, then opens it. The
 * link is never emailed in dev or CI, so its token is read from the verification table. Rate
 * limited (5 per minute in production builds): use `signInAs` everywhere else.
 */
export async function requestMagicLink(
  page: Page,
  roles: Role[],
): Promise<{ id: string; email: string }> {
  const user = await createUser(roles);
  const response = await page.request.post("/api/auth/sign-in/magic-link", {
    data: { email: user.email, callbackURL: "/" },
  });
  if (!response.ok()) throw new Error(`magic link request failed: ${response.status()}`);

  const verification = await db.verification.findFirstOrThrow({
    where: { identifier: { startsWith: "magic-link:" }, value: { contains: `"${user.email}"` } },
    orderBy: { createdAt: "desc" },
  });
  const token = verification.identifier.slice("magic-link:".length);
  await page.goto(`/api/auth/magic-link/verify?token=${token}&callbackURL=/`);
  return user;
}
