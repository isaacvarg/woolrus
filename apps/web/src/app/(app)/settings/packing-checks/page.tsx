import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { PackingChecksSection } from "./packing-checks-form";

export default async function PackingChecksPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold">{t("settings.packingChecks.title")}</h1>
      {actor && can(actor, "settings.manage") ? (
        <>
          <p className="text-base-content/70">{t("settings.packingChecks.intro")}</p>
          <PackingChecksSection />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
