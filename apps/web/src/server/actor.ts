import type { Actor } from "@woolrus/core";
import { db } from "@woolrus/db";
import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "./auth";

/** The session for the current request, shared by the layout and page of one render. */
export const currentSession = cache(async () =>
  auth().api.getSession({ headers: await headers() }),
);

/**
 * The signed-in, active user as an Actor, or null. Server components use it to decide what to show;
 * the API still checks permissions on its own (see `authed` in ./orpc).
 */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const session = await currentSession();
  const user = session ? await db.user.findUnique({ where: { id: session.user.id } }) : null;
  return user?.active ? { userId: user.id, roles: user.roles, stationId: null } : null;
});
