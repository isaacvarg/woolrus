import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { Dashboard } from "./dashboard";

/** Home: what's waiting on the floor, orders per day, and big buttons into each queue. */
export default async function HomePage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("dashboard.title")}</h1>
      {actor && can(actor, "order.read") ? (
        <Dashboard canReadReports={can(actor, "report.read")} />
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
