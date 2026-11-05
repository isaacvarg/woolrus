import { can } from "@woolrus/core";
import { currentActor } from "@/server/actor";
import { QuoteScreen } from "./quote-screen";

export default async function RateLabQuotePage() {
  const actor = await currentActor();
  // Only for showing the save buttons; the API checks it again.
  return <QuoteScreen canManage={actor ? can(actor, "ratelab.manage") : false} />;
}
