import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { ManifestsScreen } from "./manifests-screen";

export default async function ManifestsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold">{t("manifests.title")}</h1>
      {actor && can(actor, "order.ship") ? (
        <>
          <p className="text-base-content/70">{t("manifests.intro")}</p>
          <ManifestsScreen />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
