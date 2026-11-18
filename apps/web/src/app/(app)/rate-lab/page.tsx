import { can } from "@woolrus/core";
import { redirect } from "next/navigation";
import { currentActor } from "@/server/actor";

export default async function RateLabPage() {
  const actor = await currentActor();
  // Reports holders without the lab only have Real orders here.
  redirect(
    actor && !can(actor, "ratelab.use") && can(actor, "report.read")
      ? "/rate-lab/real-orders"
      : "/rate-lab/runs",
  );
}
