import { Id } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { notFound } from "next/navigation";
import { currentActor } from "@/server/actor";
import { BatchScreen } from "./batch-screen";

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  const actor = await currentActor();
  return (
    <BatchScreen
      batchId={id.data}
      userId={actor?.userId ?? null}
      canPick={actor ? can(actor, "order.pick") : false}
    />
  );
}
