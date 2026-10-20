import { stationStatus } from "@woolrus/core";
import { db } from "@woolrus/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveStationDevice } from "@/server/actor";
import { LockScreen } from "./lock-screen";

/**
 * The station lock screen: full screen, touch first (SPEC-identity "UI"). Also the way to switch
 * user while someone is on the station. A device whose station was revoked goes back to the
 * personal sign-in page; one that was never a station, too.
 */
export default async function StationPage() {
  const device = await resolveStationDevice(await headers());
  if (device.kind === "stale") redirect("/station/forget");
  if (device.kind === "none") redirect("/sign-in");
  return <LockScreen status={await stationStatus(db, device.station)} />;
}
