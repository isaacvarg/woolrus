import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { IssuesManager, type IssuesTab } from "./issues-manager";

const tabs: IssuesTab[] = ["all", "open", "resolved"];

export default async function IssuesPage({ searchParams }: PageProps<"/issues">) {
  const { tab, issue } = await searchParams;
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("issues.page.title")}</h1>
      {actor && can(actor, "order.read") ? (
        <>
          <p className="text-base-content/70">{t("issues.page.intro")}</p>
          <IssuesManager
            canResolve={can(actor, "issue.resolve")}
            canDelete={can(actor, "issue.delete")}
            canWriteCustomer={can(actor, "note.customer")}
            userId={actor.userId}
            initialTab={tabs.find((x) => x === tab) ?? "all"}
            initialIssueId={typeof issue === "string" ? issue : null}
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
