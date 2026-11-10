import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { LumexiaItems } from "./lumexia-items";

export default async function LumexiaItemsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("lumexiaItems.title")}</h1>
      {/* Only for showing the page; the API checks it again. */}
      {actor && can(actor, "lumexia.manage") ? (
        <>
          <p className="text-base-content/70">{t("lumexiaItems.intro")}</p>
          <LumexiaItems />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
