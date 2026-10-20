import { stationStatus } from "@woolrus/core";
import { db } from "@woolrus/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveStationDevice } from "@/server/actor";

/**
 * The station lock screen: full screen, touch first (SPEC-identity "UI"). A device whose station
 * was revoked goes back to the personal sign-in page; one that was never a station, too.
 */
export default async function StationPage() {
  const device = await resolveStationDevice(await headers());
  if (device.kind === "stale") redirect("/station/forget");
  if (device.kind === "none") redirect("/sign-in");
  const t = await getTranslations("station");
  const { name } = await stationStatus(db, device.station);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-base-100 p-6 text-center">
      <p className="text-lg opacity-70">{t("locked")}</p>
      <h1 className="text-5xl font-bold">{name}</h1>
      <p className="max-w-md text-xl">{t("prompt")}</p>
    </main>
  );
}
