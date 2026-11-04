import { can, fakeShippingProviders } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { CostCheckSection } from "./cost-check";
import { ProvidersSection } from "./providers";
import { RateLabCapSection } from "./rate-lab-cap";

export default async function ShippingSettingsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold">{t("settings.shipping.title")}</h1>
      {actor && can(actor, "settings.manage") ? (
        <>
          {fakeShippingProviders() && (
            <p role="status" className="alert alert-warning">
              {t("settings.shipping.fakeProviders")}
            </p>
          )}
          <p className="text-base-content/70">{t("settings.shipping.intro")}</p>
          <ProvidersSection />
          <CostCheckSection />
          <RateLabCapSection />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
