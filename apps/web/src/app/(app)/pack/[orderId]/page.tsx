import { Id } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { notFound } from "next/navigation";
import { currentActor } from "@/server/actor";
import { PackScreen } from "./pack-screen";

export default async function PackPage({ params }: { params: Promise<{ orderId: string }> }) {
  const id = Id.safeParse((await params).orderId);
  if (!id.success) notFound();
  const actor = await currentActor();

  return (
    <PackScreen
      orderId={id.data}
      userId={actor?.userId ?? null}
      // Only for showing the button; the API checks it again.
      canVoid={actor ? can(actor, "void.create") : false}
    />
  );
}
