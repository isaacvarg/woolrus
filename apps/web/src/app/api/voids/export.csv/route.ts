import { voidsCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * The Voids list as CSV, one row per void (SPEC-reporting "CSV exports"), with the list's tab and
 * search as query parameters, every page; `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["status", "search", "timeZone"]);
  return serveCsv(request, (actor, { locale }) => voidsCsv(db, actor, input, { locale }));
}
