import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { RulesManager } from "./rules-manager";

export default async function PriorityRulesPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold">{t("priorityRules.title")}</h1>
      {actor && can(actor, "settings.manage") ? (
        <>
          <p className="text-base-content/70">{t("priorityRules.intro")}</p>
          <RulesManager />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
