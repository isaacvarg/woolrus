import { resolveStationDevice } from "@/server/actor";
import { clearStationCookie } from "@/server/station-cookie";

/**
 * A revoked station's device lands here: forget the station cookie and show the personal sign-in
 * page (SPEC-identity "Revoke"). Pages can't clear an httpOnly cookie themselves. Only a stale
 * cookie is cleared: a GET anyone can link to must not un-register an active station.
 */
export async function GET(request: Request) {
  const device = await resolveStationDevice(request.headers);
  const location = new URL(device.kind === "station" ? "/station" : "/sign-in", request.url);
  return new Response(null, {
    status: 303,
    headers: {
      Location: location.toString(),
      ...(device.kind === "station" ? {} : { "Set-Cookie": clearStationCookie() }),
    },
  });
}
