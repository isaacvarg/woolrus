import { Id } from "@woolrus/contracts";
import { can } from "@woolrus/core";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { Forbidden } from "../../../../report-shell";
import { RunReport } from "./run-report";

// A run's print-ready report: `ratelab.use`, like the run's page.
export default async function RateLabRunReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  const actor = await currentActor();
  if (!actor || !can(actor, "ratelab.use")) {
    return <Forbidden message={(await getTranslations())("errors.forbidden")} />;
  }
  return <RunReport runId={id.data} autoPrint={(await searchParams).print === "1"} />;
}
