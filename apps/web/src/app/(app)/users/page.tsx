import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { UsersTabs } from "./users-tabs";

export default async function UsersPage({ searchParams }: PageProps<"/users">) {
  const { tab } = await searchParams;
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("users.title")}</h1>
      {actor && can(actor, "user.manage") ? (
        <UsersTabs
          currentUserId={actor.userId}
          initialTab={tab === "invitations" ? "invitations" : "users"}
        />
      ) : (
        <p role="alert" className="alert alert-error">
          {t("errors.forbidden")}
        </p>
      )}
    </section>
  );
}
