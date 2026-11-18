import { orderItemsCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { queryInput, serveCsv } from "@/server/csv-export";

/**
 * One row per order line on orders imported `from` through `to` in `timeZone` (SPEC-reporting
 * "CSV exports"); `report.read`, checked in core.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = queryInput(query, ["from", "to", "timeZone"]);
  return serveCsv(request, (actor, { locale }) => orderItemsCsv(db, actor, input, { locale }));
}
