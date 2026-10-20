import { acceptInvitation, getEmailSender, mayCreateAccount, sendMagicLink } from "@woolrus/core";
import { db } from "@woolrus/db";
import { defaultLocale, isLocale, type Locale } from "@woolrus/i18n";
import { createLogger } from "@woolrus/logger";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";
import { after } from "next/server";
import { env } from "./env";

const log = createLogger({ module: "auth" });

function socialProviders() {
  const e = env();
  return {
    ...(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } }
      : {}),
    ...(e.DISCORD_CLIENT_ID && e.DISCORD_CLIENT_SECRET
      ? { discord: { clientId: e.DISCORD_CLIENT_ID, clientSecret: e.DISCORD_CLIENT_SECRET } }
      : {}),
  };
}

/** The sign-in page's language, for a magic link to someone with no account yet. */
function pageLocale(headers: Headers | undefined): Locale {
  const cookie = headers?.get("cookie")?.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
  return isLocale(cookie) ? cookie : defaultLocale;
}

function createAuth() {
  return betterAuth({
    baseURL: env().BETTER_AUTH_URL,
    secret: env().BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    advanced: {
      // Let Postgres/Prisma assign UUIDv7 ids, like every other table.
      database: { generateId: false },
    },
    socialProviders: socialProviders(),
    // Failed OAuth callbacks land back on the sign-in page with `?error=<code>`, which it translates.
    onAPIError: { errorURL: "/sign-in" },
    plugins: [
      magicLink({
        // Only to people who may sign in, through the EmailSender (SPEC-identity "Sign-in
        // hardening"). Nothing is thrown back: the page says "check your email" either way. Sent
        // after the response, not awaited: a refused address answers after one query, an allowed
        // one would wait on Resend, and that difference would tell who has an account. Still not
        // a job, so the link never sits in the job table.
        sendMagicLink: async ({ email, url }, ctx) => {
          const fallbackLocale = pageLocale(ctx?.request?.headers ?? ctx?.headers);
          after(() =>
            sendMagicLink(
              db,
              { email, url, fallbackLocale },
              {
                adminEmails: env().ADMIN_EMAILS,
                // With no Resend key the link goes to the server log (dev), as before.
                sender: (db) =>
                  getEmailSender(db, {
                    timeoutMs: 10_000,
                    log: (entry) => log.warn(entry, "magic link logged, not sent: no Resend key"),
                  }),
                log,
              },
            ),
          );
        },
      }),
      // Lets the future Android client authenticate with `Authorization: Bearer <token>`.
      bearer(),
      nextCookies(),
    ],
    databaseHooks: {
      session: {
        create: {
          // A deactivated user can't start a session (e.g. a Google sign-in, or a link sent
          // before deactivation). Better Auth then redirects with `failed_to_create_session`
          // (magic link) or `unable_to_create_session` (OAuth), which the sign-in page shows as
          // errors.auth.deactivated.
          before: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { active: true },
            });
            if (user?.active) return;
            log.info({ userId: session.userId }, "sign-in refused: user deactivated");
            return false;
          },
        },
      },
      user: {
        create: {
          // Invite-only (NFR-SEC-02): no open invitation, no account. ADMIN_EMAILS bootstraps the
          // first admin. Either needs a verified email. The rule and its tests live in core
          // (identity/sign-in.ts).
          before: async (user) => {
            if (await mayCreateAccount(db, user, env().ADMIN_EMAILS)) return;
            log.warn(
              { email: user.email.toLowerCase(), emailVerified: user.emailVerified },
              "sign-in refused: no invitation, or an unverified email",
            );
            return false;
          },
          after: async (user) => acceptInvitation(db, user, env().ADMIN_EMAILS),
        },
      },
    },
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Created on first use so building the app doesn't require auth secrets. */
export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}
