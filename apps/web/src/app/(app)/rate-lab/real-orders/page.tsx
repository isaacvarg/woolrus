import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { RealOrdersDashboard } from "./real-orders-dashboard";

// Real orders reads real packages' costs: report.read (Admin) on top of Rate Lab.
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
  return <RealOrdersDashboard />;
}
