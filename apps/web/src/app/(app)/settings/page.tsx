import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { GeneralSection } from "./general-form";

export default async function SettingsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold">{t("settings.title")}</h1>
      {actor && can(actor, "settings.manage") ? (
        <GeneralSection />
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
