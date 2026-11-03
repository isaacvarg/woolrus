import { can } from "@woolrus/core";
import { currentActor } from "@/server/actor";
import { AddressesManager } from "./addresses-manager";

export default async function RateLabAddressesPage() {
  const actor = await currentActor();
  // Only for showing the controls; the API checks it again.
  return <AddressesManager canManage={actor ? can(actor, "ratelab.manage") : false} />;
}
