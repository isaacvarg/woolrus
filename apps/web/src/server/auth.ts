import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";
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

async function openInvitation(email: string) {
  return db.invitation.findFirst({
    where: {
      email: email.toLowerCase(),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
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
    plugins: [
      magicLink({
        // TODO(email): wire an SMTP provider. Until then the link is only logged (dev use).
        sendMagicLink: async ({ email, url }) => {
          log.warn({ email, url }, "magic link (no email provider configured)");
        },
      }),
      // Lets the future Android client authenticate with `Authorization: Bearer <token>`.
      bearer(),
      nextCookies(),
    ],
    databaseHooks: {
      user: {
        create: {
          // Invite-only (NFR-SEC-02): no invitation, no account. ADMIN_EMAILS bootstraps the first admin.
          before: async (user) => {
            const email = user.email.toLowerCase();
            if (env().ADMIN_EMAILS.includes(email)) return;
            if (await openInvitation(email)) return;
            log.warn({ email }, "sign-in refused: no invitation");
            return false;
          },
          after: async (user) => {
            const email = user.email.toLowerCase();
            const invitation = await openInvitation(email);
            const roles = env().ADMIN_EMAILS.includes(email)
              ? ["ADMIN" as const]
              : (invitation?.roles ?? []);
            await db.$transaction([
              db.user.update({ where: { id: user.id }, data: { roles } }),
              ...(invitation
                ? [
                    db.invitation.update({
                      where: { id: invitation.id },
                      data: { acceptedAt: new Date() },
                    }),
                  ]
                : []),
            ]);
          },
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
