import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { currentActor } from "@/server/actor";
import { ReportsHeader } from "./reports-header";

// Reports (SPEC-reporting "UI"): `report.read`, so Admins and the Reports role. The API checks every
// report call again.
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("reports.title")}</h1>
      {actor && can(actor, "report.read") ? (
        // The header and every tab read the range from the URL query.
        <Suspense fallback={<p>{t("common.loading")}</p>}>
          <ReportsHeader />
          {children}
        </Suspense>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
