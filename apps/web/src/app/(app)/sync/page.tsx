import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { SyncRuns } from "./sync-runs";

export default async function SyncPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("sync.page.title")}</h1>
      {actor && can(actor, "settings.manage") ? (
        <>
          <p className="text-base-content/70">{t("sync.page.intro")}</p>
          <SyncRuns />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
