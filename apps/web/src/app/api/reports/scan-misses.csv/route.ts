import { scanMissesCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * One row per blocked scan (SPEC-reporting "CSV exports") in the Quality tab's range;
 * `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["from", "to", "timeZone"]);
  return serveCsv(request, (actor, { locale }) => scanMissesCsv(db, actor, input, { locale }));
}
