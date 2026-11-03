import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { RateLabTabs } from "./tabs";

// Rate Lab (SPEC-rate-lab): for the Rate Lab role and Admins. The API checks every call again.
export default async function RateLabLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("rateLab.title")}</h1>
      {actor && can(actor, "ratelab.use") ? (
        <>
          <RateLabTabs showRealOrders={can(actor, "report.read")} />
          {children}
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
