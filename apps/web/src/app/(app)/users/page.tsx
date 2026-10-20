import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { UsersManager } from "./users-manager";

export default async function UsersPage() {
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("users.title")}</h1>
      {actor && can(actor, "user.manage") ? (
        <UsersManager currentUserId={actor.userId} />
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
