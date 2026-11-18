import { cycleTimeCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * One row per order shipped `from` through `to` in `timeZone`, with its durations in minutes
 * (SPEC-reporting "CSV exports"); `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["from", "to", "timeZone"]);
  return serveCsv(request, (actor, { locale }) => cycleTimeCsv(db, actor, input, { locale }));
}
