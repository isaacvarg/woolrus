import { ordersCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * The All orders list as CSV (SPEC-reporting "CSV exports"), with the list's filters and sort as
 * query parameters, every page; `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["search", "sort", "dir", "timeZone"], ["statuses"]);
  return serveCsv(request, (actor, { locale }) => ordersCsv(db, actor, input, { locale }));
}
