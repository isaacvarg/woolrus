import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveStationDevice } from "@/server/actor";
import { SetupForm } from "./setup-form";

/**
 * Redeem an admin's setup code on the device that will be the station (SPEC-identity A3). Loading
 * the page never redeems: `?code=` (from the QR link) only pre-fills the field, so link scanners
 * and prefetchers can't burn a code; **Set up** does. `Referrer-Policy: no-referrer` comes from
 * next.config.ts. A device that already is a station goes to its lock screen: to re-pair it,
 * revoke its station first.
 */
export default async function StationSetupPage({ searchParams }: PageProps<"/station/setup">) {
  const device = await resolveStationDevice(await headers());
  if (device.kind === "station") redirect("/station");
  const { code } = await searchParams;
  return <SetupForm initialCode={typeof code === "string" ? code.slice(0, 64) : ""} />;
}
