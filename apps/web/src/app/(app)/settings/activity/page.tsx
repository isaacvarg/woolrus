import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { ActivityVisibilitySection } from "./activity-visibility-form";

export default async function ActivitySettingsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold">{t("settings.activity.title")}</h1>
      {actor && can(actor, "settings.manage") ? (
        <>
          <p className="text-base-content/70">{t("settings.activity.intro")}</p>
          <ActivityVisibilitySection />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
