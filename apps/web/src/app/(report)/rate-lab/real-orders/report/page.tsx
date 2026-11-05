import { isQueryTrue } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { Forbidden } from "../../../report-shell";
import { RealOrdersReport } from "./real-orders-report";

type Search = Record<string, string | string[] | undefined>;

const one = (value: Search[string]) => (typeof value === "string" && value ? value : undefined);

// The Real orders report: `report.read`, the one rule for Real orders data (SPEC-rate-lab
// "Permissions"), as the procedure and the CSV export check it. The filters come from the screen's
// link.
export default async function RateLabRealOrdersReportPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const actor = await currentActor();
  if (!actor || !can(actor, "report.read")) {
    return <Forbidden message={(await getTranslations())("errors.forbidden")} />;
  }
  const search = await searchParams;
  return (
    <RealOrdersReport
      input={{
        from: one(search.from),
        to: one(search.to),
        carrierId: one(search.carrierId),
        serviceId: one(search.serviceId),
        country: one(search.country),
        state: one(search.state),
        boxId: one(search.boxId),
        includeFake: isQueryTrue(search.includeFake),
      }}
      autoPrint={search.print === "1"}
    />
  );
}
