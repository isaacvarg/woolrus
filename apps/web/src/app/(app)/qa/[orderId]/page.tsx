import { Id } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { notFound } from "next/navigation";
import { currentActor } from "@/server/actor";
import { QaScreen } from "./qa-screen";

export default async function QaPage({ params }: { params: Promise<{ orderId: string }> }) {
  const id = Id.safeParse((await params).orderId);
  if (!id.success) notFound();
  const actor = await currentActor();

  return (
    <QaScreen
      orderId={id.data}
      userId={actor?.userId ?? null}
      // Only for showing the controls; the API checks again.
      canVerify={actor ? can(actor, "order.qa") : false}
      canPurchase={actor ? can(actor, "order.qa") && can(actor, "label.purchase") : false}
      canReport={actor ? can(actor, "issue.report") : false}
      canWriteCustomer={actor ? can(actor, "note.customer") : false}
    />
  );
}
