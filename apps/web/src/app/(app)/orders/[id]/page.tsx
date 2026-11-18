import { Id } from "@woolrus/contracts";
import { activityPartsFor, can, seesActivity } from "@woolrus/core";
import { db } from "@woolrus/db";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { currentActor } from "@/server/actor";
import { OrderView } from "./order-view";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  const actor = await currentActor();
  const t = await getTranslations();

  // The open tab is read from the URL on the client (useSearchParams).
  return (
    <Suspense fallback={<p>{t("common.loading")}</p>}>
      <OrderView
        id={id.data}
        userId={actor?.userId ?? null}
        // Only for showing the visibility switch; the API checks it again.
        canWriteCustomer={actor ? can(actor, "note.customer") : false}
        canVoid={actor ? can(actor, "void.create") : false}
        canReport={actor ? can(actor, "issue.report") : false}
        canRefreshRates={actor ? can(actor, "order.qa") : false}
        canPrint={actor ? can(actor, "label.print") : false}
        canRetryPush={actor ? can(actor, "settings.manage") : false}
        // The API leaves hidden parts out anyway; this only drops a tab that would be empty.
        showHistory={actor ? seesActivity(await activityPartsFor(db, actor)) : false}
      />
    </Suspense>
  );
}
