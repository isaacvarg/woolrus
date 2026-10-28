import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { FailedJobs } from "./failed-jobs";

export default async function JobsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("jobs.title")}</h1>
      {actor && can(actor, "ops.jobs") ? (
        <>
          <p className="text-base-content/70">{t("jobs.intro")}</p>
          <FailedJobs />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
