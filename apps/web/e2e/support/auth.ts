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
  await signInAsUser(page, user.id);
  return user;
}

/** Signs `page`'s browser context in as an existing user, with a new session of its own. */
export async function signInAsUser(page: Page, userId: string): Promise<void> {
  const { test } = await testAuth.$context;
  await page.context().addCookies(await test.getCookies({ userId }));
}

/**
 * Signs in through the full user flow: asks `/sign-in/magic-link` for a link, then opens it. The
 * link is never emailed in dev or CI, so its token is read from the verification table. Use it
 * only where the sign-in flow is what's tested: `signInAs` everywhere else.
 */
export async function requestMagicLink(
  page: Page,
  roles: Role[],
): Promise<{ id: string; email: string }> {
  const user = await createUser(roles);
  await followMagicLink(page, user.email);
  return user;
}

/** A random private (10.0.0.0/8) address: never a real client. */
const testClientIp = () =>
  `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 254) + 1).join(".")}`;

/**
 * Asks for a magic link for `email` and follows it the way the recipient would, with the sign-in
 * page as the error callback. The token is read from the verification table: Better Auth stores it
 * before our sender decides whether to email it (dev and CI log the link instead), so this also
 * stands in for a link that leaked.
 */
export async function followMagicLink(page: Page, email: string): Promise<void> {
  const ip = testClientIp();
  const response = await page.request.post("/api/auth/sign-in/magic-link", {
    data: { email, callbackURL: "/", errorCallbackURL: "/sign-in" },
    // Production builds (CI) rate limit magic links to 5 a minute per client IP, which Better Auth
    // reads from x-forwarded-for. With none, every test shares one bucket and the suite gets 429s.
    // A made-up address per sign-in stands for a separate person, so the real limiter still runs.
    headers: { "x-forwarded-for": ip },
  });
  if (!response.ok()) throw new Error(`magic link request failed: ${response.status()}`);
  const verification = await db.verification.findFirstOrThrow({
    where: { identifier: { startsWith: "magic-link:" }, value: { contains: `"${email}"` } },
    orderBy: { createdAt: "desc" },
  });
  const token = verification.identifier.slice("magic-link:".length);
  // Opening the link is rate limited too: the same person opens it.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": ip });
  try {
    await page.goto(
      `/api/auth/magic-link/verify?token=${token}&callbackURL=/&errorCallbackURL=/sign-in`,
    );
  } finally {
    await page.setExtraHTTPHeaders({});
  }
}
