import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { currentActor } from "@/server/actor";
import { RealOrdersDashboard } from "./real-orders-dashboard";

// Real orders reads real packages' costs: report.read (Admins and the Reports role).
export default async function RateLabRealOrdersPage() {
  const t = await getTranslations();
  const actor = await currentActor();
  if (!actor || !can(actor, "report.read")) {
    return (
      <p role="alert" className="alert alert-error">
        {t("errors.forbidden")}
      </p>
    );
  }
  // The dashboard opens on the `from`/`to` in the URL (Reports → Spend).
  return (
    <Suspense fallback={<p>{t("common.loading")}</p>}>
      <RealOrdersDashboard />
    </Suspense>
  );
}
