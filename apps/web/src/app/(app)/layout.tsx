import { boxPickerColumns, can, publicEmail } from "@woolrus/core";
import type { MessageKey } from "@woolrus/i18n";
import type { Route } from "next";
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
import { FailedJobsNav } from "./failed-jobs-nav";
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

  // Each group's links, already narrowed to what this actor may open: a heading shows only over
  // at least one link.
  const visible = (
    links: { href: Route; label: Extract<MessageKey, `nav.${string}`>; show: boolean }[],
  ) => links.filter((link) => link.show);
  const tools = visible([
    { href: "/reports", label: "nav.reports", show: can(actor, "report.read") },
    { href: "/lots", label: "nav.lotLookup", show: can(actor, "order.read") },
    { href: "/manifests", label: "nav.manifests", show: can(actor, "order.ship") },
    // Reports holders reach Real orders, under Rate Lab, without the lab itself.
    {
      href: "/rate-lab",
      label: "nav.rateLab",
      show: can(actor, "ratelab.use") || can(actor, "report.read"),
    },
  ]);
  const showFailedJobs = can(actor, "ops.jobs");
  const settings = can(actor, "settings.manage");
  const configs = visible([
    { href: "/boxes", label: "nav.boxes", show: true },
    { href: "/users", label: "nav.users", show: can(actor, "user.manage") },
    { href: "/stations", label: "nav.stations", show: can(actor, "station.manage") },
    { href: "/settings", label: "nav.settings", show: settings },
    { href: "/settings/priority-rules", label: "nav.priorityRules", show: settings },
    { href: "/settings/shipping", label: "nav.shippingSettings", show: settings },
    { href: "/settings/packing-checks", label: "nav.packingChecks", show: settings },
    { href: "/settings/activity", label: "nav.activityVisibility", show: settings },
    { href: "/settings/customs", label: "nav.customs", show: can(actor, "product.manage") },
    { href: "/lumexia", label: "nav.lumexiaItems", show: can(actor, "lumexia.manage") },
    { href: "/sync", label: "nav.sync", show: settings },
  ]);

  return (
    <div className={`drawer ${collapsed ? "" : "lg:drawer-open"}`}>
      <OrderEvents />
      {idleLockAt && <StationIdleLock idleLockAt={idleLockAt} />}
      <input id="nav" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex flex-col">
        <header className={`navbar bg-base-100 shadow-sm ${collapsed ? "" : "lg:hidden"}`}>
          <label htmlFor="nav" className="btn btn-ghost" aria-label={t("nav.openMenu")}>
            ☰
          </label>
          <Link href="/" className="btn btn-ghost px-2 text-lg font-semibold">
            {t("common.appName")}
          </Link>
        </header>
        <main className="p-4 lg:p-8">{children}</main>
      </div>
      <div className="drawer-side">
        <label htmlFor="nav" aria-label={t("nav.closeMenu")} className="drawer-overlay" />
        <DrawerNav toggleId="nav">
          <Link href="/" className="mb-4 px-2 text-xl font-bold">
            {t("common.appName")}
          </Link>
          {can(actor, "order.pick") && (
            <li className="mb-2">
              <Link href="/pick">{t("nav.myPicks")}</Link>
            </li>
          )}
          <QueueNav />
          {(tools.length > 0 || showFailedJobs) && (
            <>
              <li className="menu-title mt-4">{t("nav.tools")}</li>
              {tools.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{t(link.label)}</Link>
                </li>
              ))}
              {showFailedJobs && <FailedJobsNav />}
            </>
          )}
          {configs.length > 0 && (
            <>
              <li className="menu-title mt-4">{t("nav.configs")}</li>
              {configs.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{t(link.label)}</Link>
                </li>
              ))}
            </>
          )}
          {/* Sync status sits at the bottom, just above who is signed in. */}
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <SyncIndicator />
            {user && (
              <NavFooter
                name={user.name}
                email={publicEmail(user.email)}
                stationName={station?.name ?? null}
                preferences={{
                  locale: user.locale,
                  theme: user.theme,
                  sidebarCollapsed: user.sidebarCollapsed,
                  boxPickerColumns: boxPickerColumns(user.boxPickerColumns),
                }}
              />
            )}
          </div>
        </DrawerNav>
      </div>
    </div>
  );
}
