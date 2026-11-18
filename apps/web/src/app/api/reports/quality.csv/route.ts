import { qualityCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * One row per quality issue (SPEC-reporting "CSV exports"), with the Quality tab's range and
 * filters; `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, [
    "from",
    "to",
    "timeZone",
    "severity",
    "customerReported",
    "status",
  ]);
  return serveCsv(request, (actor, { locale }) => qualityCsv(db, actor, input, { locale }));
}
