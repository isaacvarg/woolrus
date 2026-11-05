import { isQueryTrue } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { Forbidden } from "../../../report-shell";
import { TrendsReport } from "./trends-report";

type Search = Record<string, string | string[] | undefined>;

const list = (value: Search[string]) => (value === undefined ? [] : [value].flat());
const one = (value: Search[string]) => (typeof value === "string" ? value : "");

// The Trends report: `ratelab.use`, like Trends. The filters come from the screen's link.
export default async function RateLabTrendsReportPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const actor = await currentActor();
  if (!actor || !can(actor, "ratelab.use")) {
    return <Forbidden message={(await getTranslations())("errors.forbidden")} />;
  }
  const search = await searchParams;
  return (
    <TrendsReport
      filters={{
        addressGroupIds: list(search.addressGroupIds),
        parcelGroupIds: list(search.parcelGroupIds),
        carrierIds: list(search.carrierIds),
        from: one(search.from),
        to: one(search.to),
        includeFake: isQueryTrue(search.includeFake),
      }}
      autoPrint={search.print === "1"}
    />
  );
}
