import { Id } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { notFound } from "next/navigation";
import { currentActor } from "@/server/actor";
import { OrderView } from "./order-view";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  const actor = await currentActor();

  return (
    <OrderView
      id={id.data}
      userId={actor?.userId ?? null}
      // Only for showing the visibility switch; the API checks it again.
      canWriteCustomer={actor ? can(actor, "note.customer") : false}
    />
  );
}
