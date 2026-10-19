import type { UserActor } from "@woolrus/core";
import { db, type User } from "@woolrus/db";
import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "./auth";

/**
 * The one rule for who is acting: the session (cookie or bearer token) must belong to an active
 * user. Used by the API's `authed` middleware and by server components, so they always agree.
 * Always a UserActor: a request can never act as the system actor.
 */
export async function resolveActor(
  requestHeaders: Headers,
): Promise<{ user: User; actor: UserActor } | null> {
  const session = await auth().api.getSession({ headers: requestHeaders });
  const user = session ? await db.user.findUnique({ where: { id: session.user.id } }) : null;
  if (!user?.active) return null;
  return { user, actor: { userId: user.id, roles: user.roles, stationId: null } };
}

/** The session for the current request, shared by the layout and page of one render. */
export const currentSession = cache(async () =>
  auth().api.getSession({ headers: await headers() }),
);

/**
 * The current request's Actor, or null. Server components use it to decide what to show; the API
 * still checks permissions on its own.
 */
export const currentActor = cache(
  async (): Promise<UserActor | null> => (await resolveActor(await headers()))?.actor ?? null,
);
