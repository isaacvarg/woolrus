import { throughputCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * Throughput per day × stage × person (SPEC-reporting "CSV exports"), with the Throughput tab's
 * range and filters; `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["from", "to", "timeZone", "stage", "person"]);
  return serveCsv(request, (actor, { locale }) => throughputCsv(db, actor, input, { locale }));
}
