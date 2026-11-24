import { Id } from "@woolrus/contracts";
import { boxPickerColumns, can } from "@woolrus/core";
import { notFound } from "next/navigation";
import { currentActor, currentUser } from "@/server/actor";
import { PackScreen } from "./pack-screen";

export default async function PackPage({ params }: { params: Promise<{ orderId: string }> }) {
  const id = Id.safeParse((await params).orderId);
  if (!id.success) notFound();
  const actor = await currentActor();
  const user = await currentUser();

  return (
    <PackScreen
      orderId={id.data}
      userId={actor?.userId ?? null}
      // Only for showing the button; the API checks it again.
      canVoid={actor ? can(actor, "void.create") : false}
      canReport={actor ? can(actor, "issue.report") : false}
      canWriteCustomer={actor ? can(actor, "note.customer") : false}
      // The signed-in user's choice (SPEC-packing A2); it follows them to every station.
      boxPickerColumns={user ? boxPickerColumns(user.boxPickerColumns) : 1}
    />
  );
}
