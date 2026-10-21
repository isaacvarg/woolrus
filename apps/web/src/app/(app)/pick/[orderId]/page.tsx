import { Id } from "@woolrus/contracts";
import { notFound } from "next/navigation";
import { currentActor } from "@/server/actor";
import { PickScreen } from "./pick-screen";

export default async function PickPage({ params }: { params: Promise<{ orderId: string }> }) {
  const id = Id.safeParse((await params).orderId);
  if (!id.success) notFound();
  const actor = await currentActor();

  return <PickScreen orderId={id.data} userId={actor?.userId ?? null} />;
}
