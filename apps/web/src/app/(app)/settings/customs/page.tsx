import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { CustomsEditor } from "./customs-editor";

export default async function CustomsPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("customs.title")}</h1>
      {actor && can(actor, "product.manage") ? (
        <>
          <p className="text-base-content/70">{t("customs.intro")}</p>
          <CustomsEditor />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
