import { env } from "./env";

// The station device credential (SPEC-identity "Actor resolution"): an opaque random token in an
// httpOnly cookie. Only its SHA-256 is in the database.

export const STATION_COOKIE = "woolrus_station";
const MAX_AGE = 400 * 24 * 60 * 60; // The longest browsers keep a cookie.

function attributes(maxAge: number): string {
  const secure = env().NODE_ENV === "development" ? "" : "; Secure";
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export const stationCookie = (token: string) =>
  `${STATION_COOKIE}=${token}; ${attributes(MAX_AGE)}`;

/** Sent when the cookie names no active station (revoked), so the device stops trying. */
export const clearStationCookie = () => `${STATION_COOKIE}=; ${attributes(0)}`;

export function stationToken(headers: Headers): string | null {
  const match = headers.get("cookie")?.match(/(?:^|;\s*)woolrus_station=([^;]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null; // Malformed (hand-edited): no station, rather than a 500 on every request.
  }
}
