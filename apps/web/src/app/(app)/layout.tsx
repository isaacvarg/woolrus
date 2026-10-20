import { can } from "@woolrus/core";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OrderEvents } from "@/lib/live";
import { currentActor, currentSession } from "@/server/actor";
import { QueueNav } from "./queue-nav";
import { SyncIndicator } from "./sync-indicator";

// Everything under (app) requires a session. The API enforces auth independently; this only
// keeps signed-out users on the sign-in page.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session) redirect("/sign-in");
  const actor = await currentActor();
  const t = await getTranslations();

  return (
    <div className="drawer lg:drawer-open">
      <OrderEvents />
      <input id="nav" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex flex-col">
        <header className="navbar bg-base-100 shadow-sm lg:hidden">
          <label htmlFor="nav" className="btn btn-ghost" aria-label="Open menu">
            ☰
          </label>
          <span className="font-semibold">{t("common.appName")}</span>
        </header>
        <main className="p-4 lg:p-8">{children}</main>
      </div>
      <div className="drawer-side">
        <label htmlFor="nav" aria-label="Close menu" className="drawer-overlay" />
        <nav className="menu min-h-full w-64 bg-base-100 p-4">
          <span className="mb-4 px-2 text-xl font-bold">{t("common.appName")}</span>
          <QueueNav />
          <div className="mt-2">
            <SyncIndicator />
          </div>
          <li className="mt-4">
            <Link href="/boxes">{t("nav.boxes")}</Link>
          </li>
          {actor && can(actor, "user.manage") && (
            <li>
              <Link href="/users">{t("nav.users")}</Link>
            </li>
          )}
          {actor && can(actor, "settings.manage") && (
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
        </nav>
      </div>
    </div>
  );
}
