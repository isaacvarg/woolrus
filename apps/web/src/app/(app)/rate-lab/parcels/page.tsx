import { can } from "@woolrus/core";
import { currentActor } from "@/server/actor";
import { ParcelsManager } from "./parcels-manager";

export default async function RateLabParcelsPage() {
  const actor = await currentActor();
  // Only for showing the controls; the API checks it again.
  return <ParcelsManager canManage={actor ? can(actor, "ratelab.manage") : false} />;
}
