import { issuesCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * The Issues list as CSV (SPEC-reporting "CSV exports"), with the list's tab and filters as query
 * parameters, every page; `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["status", "severity", "type", "orderId", "search", "timeZone"]);
  return serveCsv(request, (actor, { locale }) => issuesCsv(db, actor, input, { locale }));
}
