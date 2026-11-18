import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";

/**
 * The lab's own sections (runs, addresses, parcels, quote, trends) need `ratelab.use`. Rate Lab's
 * layout also lets `report.read` in, for Real orders alone (SPEC-reporting "Spend").
 */
export default async function LabOnlyLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  if (actor && can(actor, "ratelab.use")) return children;
  const t = await getTranslations();
  return (
    <p role="alert" className="alert alert-error">
      {t("errors.forbidden")}
    </p>
  );
}
