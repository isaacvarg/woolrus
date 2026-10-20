import { clearStationCookie } from "@/server/station-cookie";

/**
 * A revoked station's device lands here: forget the station cookie and show the personal sign-in
 * page (SPEC-identity "Revoke"). Pages can't clear an httpOnly cookie themselves.
 */
export function GET(request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL("/sign-in", request.url).toString(),
      "Set-Cookie": clearStationCookie(),
    },
  });
}
