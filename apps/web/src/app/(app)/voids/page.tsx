import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { VoidsManager } from "./voids-manager";

export default async function VoidsPage({ searchParams }: PageProps<"/voids">) {
  const { tab } = await searchParams;
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("voids.page.title")}</h1>
      {actor && can(actor, "order.read") ? (
        <>
          <p className="text-base-content/70">{t("voids.page.intro")}</p>
          <VoidsManager
            canResolve={can(actor, "void.resolve")}
            initialTab={tab === "resolved" ? "resolved" : "unresolved"}
          />
        </>
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
