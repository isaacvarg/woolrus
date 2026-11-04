import { labRunCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { serveCsv } from "@/server/csv-export";

/** A run's quotes as CSV (SPEC-rate-lab "Exports"); `ratelab.use`, like the run's page. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/rate-lab/runs/[id]/export.csv">,
) {
  const { id } = await params;
  return serveCsv(request, (actor) => labRunCsv(db, actor, { id }));
}
