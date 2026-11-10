import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { LotLookup } from "./lot-lookup";

export default async function LotLookupPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("lotLookup.title")}</h1>
      {/* Only for showing the page; the API checks it again. */}
      {actor && can(actor, "order.read") ? (
        <>
          <p className="text-base-content/70">{t("lotLookup.intro")}</p>
          <LotLookup />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
