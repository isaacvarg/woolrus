import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { StationsManager } from "./stations-manager";

export default async function StationsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("stations.title")}</h1>
      {actor && can(actor, "station.manage") ? (
        <StationsManager />
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
