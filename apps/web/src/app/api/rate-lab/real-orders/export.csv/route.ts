import { isQueryTrue } from "@woolrus/contracts";
import { realOrdersCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { serveCsv } from "@/server/csv-export";

const FILTERS = ["from", "to", "carrierId", "serviceId", "country", "state", "boxId"] as const;

/**
 * The Real orders dashboard's quotes as CSV (SPEC-rate-lab "Exports"), with the dashboard's
 * filters as query parameters. `report.read` alone, checked in core like the dashboard's procedure
 * and the PDF report: the one rule for Real orders data.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = {
    ...Object.fromEntries(
      FILTERS.flatMap((name) => (query.get(name) ? [[name, query.get(name)]] : [])),
    ),
    includeFake: isQueryTrue(query.get("includeFake")),
  };
  return serveCsv(request, (actor) => realOrdersCsv(db, actor, input));
}
