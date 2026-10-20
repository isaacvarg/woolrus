import { findStationByToken, stationActor, type UserActor } from "@woolrus/core";
import { db, type Station, type User } from "@woolrus/db";
import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "./auth";
import { stationToken } from "./station-cookie";

export type Resolved = { user: User; actor: UserActor; station: Station | null };

/**
 * The one rule for who is acting (SPEC-identity "Actor resolution"), used by the API's `authed`
 * middleware and by server components, so they always agree:
 * 1. a session (cookie or bearer token) of an active user: a personal actor;
 * 2. else a station cookie of an active station with an open activation for an active user: that
 *    user, with exactly their roles, at that station;
 * 3. else nobody. Always a UserActor: a request can never act as the system actor.
 */
export async function resolveActor(requestHeaders: Headers): Promise<Resolved | null> {
  const session = await auth().api.getSession({ headers: requestHeaders });
  if (session) {
    // A personal session wins even on a station device (an admin signed in there on purpose).
    const user = await db.user.findUnique({ where: { id: session.user.id } });
    if (user?.active) {
      return {
        user,
        actor: { userId: user.id, roles: user.roles, stationId: null },
        station: null,
      };
    }
  }
  const device = await resolveStationDevice(requestHeaders);
  if (device.kind !== "station") return null;
  const unlocked = await stationActor(db, device.station);
  return unlocked && { ...unlocked, station: device.station };
}

/**
 * What the station cookie says about this device: no cookie, an active station, or a cookie whose
 * station is gone (revoked), which the caller should clear.
 */
export async function resolveStationDevice(
  requestHeaders: Headers,
): Promise<{ kind: "none" } | { kind: "station"; station: Station } | { kind: "stale" }> {
  const token = stationToken(requestHeaders);
  if (!token) return { kind: "none" };
  const station = await findStationByToken(db, token);
  return station ? { kind: "station", station } : { kind: "stale" };
}

/** The current request's active user and Actor, or null. */
const currentResolved = cache(async () => resolveActor(await headers()));

/** The station this request acts from, if any. */
export const currentStation = cache(
  async (): Promise<Station | null> => (await currentResolved())?.station ?? null,
);

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
