import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/server/auth";

// Everything under (app) requires a session. The API enforces auth independently; this only
// keeps signed-out users on the sign-in page.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const t = await getTranslations();

  return (
    <div className="drawer lg:drawer-open">
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
          <li>
            <Link href="/boxes">{t("nav.boxes")}</Link>
          </li>
        </nav>
      </div>
    </div>
  );
}
