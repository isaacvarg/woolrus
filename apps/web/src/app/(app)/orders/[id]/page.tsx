import { Id } from "@woolrus/contracts";
import { notFound } from "next/navigation";
import { currentActor } from "@/server/actor";
import { OrderView } from "./order-view";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  const actor = await currentActor();

  return <OrderView id={id.data} userId={actor?.userId ?? null} />;
}
