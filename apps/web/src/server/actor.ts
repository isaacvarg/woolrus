import { findStationByToken, type UserActor } from "@woolrus/core";
import { db, type Station, type User } from "@woolrus/db";
import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "./auth";
import { stationToken } from "./station-cookie";

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

/**
 * What the station cookie says about this device: no cookie, an active station, or a cookie whose
 * station is gone (revoked), which the caller should clear. Until a user unlocks it (later
 * ticket), a station acts as nobody: requests get `errors.station.locked`.
 */
export async function resolveStationDevice(
  requestHeaders: Headers,
): Promise<{ kind: "none" } | { kind: "station"; station: Station } | { kind: "stale" }> {
  const token = stationToken(requestHeaders);
  if (!token) return { kind: "none" };
  const station = await findStationByToken(db, token);
  return station ? { kind: "station", station } : { kind: "stale" };
}

/** The session for the current request, shared by the layout and page of one render. */
export const currentSession = cache(async () =>
  auth().api.getSession({ headers: await headers() }),
);

/** The current request's active user and Actor, or null. */
const currentResolved = cache(async () => resolveActor(await headers()));

/** The signed-in user's row, for their preferences (FR-SET-03). */
export const currentUser = cache(
  async (): Promise<User | null> => (await currentResolved())?.user ?? null,
);

/**
 * The current request's Actor, or null. Server components use it to decide what to show; the API
 * still checks permissions on its own.
 */
export const currentActor = cache(
  async (): Promise<UserActor | null> => (await currentResolved())?.actor ?? null,
);
