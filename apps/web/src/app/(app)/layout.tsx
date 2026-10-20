import { can } from "@woolrus/core";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OrderEvents } from "@/lib/live";
import {
  currentActor,
  currentIdleLockAt,
  currentStation,
  currentUser,
  resolveStationDevice,
} from "@/server/actor";
import { DrawerNav } from "./drawer-nav";
import { NavFooter } from "./nav-footer";
import { QueueNav } from "./queue-nav";
import { StationIdleLock } from "./station-idle-lock";
import { SyncIndicator } from "./sync-indicator";

// Everything under (app) requires someone acting: a personal session or an unlocked station. The
// API enforces auth independently; this only keeps everyone else on the sign-in or lock screen.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  // A station device never shows the personal sign-in page: it shows its lock screen, which also
  // forgets a revoked station's cookie. A personal session on a station device wins.
  if (!actor) {
    const device = await resolveStationDevice(await headers());
    redirect(device.kind === "none" ? "/sign-in" : "/station");
  }
  const user = await currentUser();
  const station = await currentStation();
  const idleLockAt = await currentIdleLockAt();
  const t = await getTranslations();
  // A collapsed sidebar on desktop behaves like the tablet drawer: hidden behind the menu button.
  const collapsed = user?.sidebarCollapsed ?? false;

  return (
    <div className={`drawer ${collapsed ? "" : "lg:drawer-open"}`}>
      <OrderEvents />
      {idleLockAt && <StationIdleLock idleLockAt={idleLockAt} />}
      <input id="nav" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex flex-col">
        <header className={`navbar bg-base-100 shadow-sm ${collapsed ? "" : "lg:hidden"}`}>
          <label htmlFor="nav" className="btn btn-ghost" aria-label="Open menu">
            ☰
          </label>
          <span className="font-semibold">{t("common.appName")}</span>
        </header>
        <main className="p-4 lg:p-8">{children}</main>
      </div>
      <div className="drawer-side">
        <label htmlFor="nav" aria-label="Close menu" className="drawer-overlay" />
        <DrawerNav toggleId="nav">
          <span className="mb-4 px-2 text-xl font-bold">{t("common.appName")}</span>
          <QueueNav />
          <div className="mt-2">
            <SyncIndicator />
          </div>
          <li className="mt-4">
            <Link href="/boxes">{t("nav.boxes")}</Link>
          </li>
          {can(actor, "user.manage") && (
            <li>
              <Link href="/users">{t("nav.users")}</Link>
            </li>
          )}
          {can(actor, "station.manage") && (
            <li>
              <Link href="/stations">{t("nav.stations")}</Link>
            </li>
          )}
          {can(actor, "settings.manage") && (
            <>
              <li>
                <Link href="/settings">{t("nav.settings")}</Link>
              </li>
              <li>
                <Link href="/settings/priority-rules">{t("nav.priorityRules")}</Link>
              </li>
              <li>
                <Link href="/sync">{t("nav.sync")}</Link>
              </li>
            </>
          )}
          {user && (
            <NavFooter
              name={user.name}
              email={user.email}
              stationName={station?.name ?? null}
              preferences={{
                locale: user.locale,
                theme: user.theme,
                sidebarCollapsed: user.sidebarCollapsed,
              }}
            />
          )}
        </DrawerNav>
      </div>
    </div>
  );
}
