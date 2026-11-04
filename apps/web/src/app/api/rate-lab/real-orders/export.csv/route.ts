import { realOrdersCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { serveCsv } from "@/server/csv-export";

const FILTERS = ["from", "to", "carrierId", "serviceId", "country", "state", "boxId"] as const;

/**
 * The Real orders dashboard's quotes as CSV (SPEC-rate-lab "Exports"), with the dashboard's
 * filters as query parameters; `report.read`, like the dashboard.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const input = {
    ...Object.fromEntries(
      FILTERS.flatMap((name) => (query.get(name) ? [[name, query.get(name)]] : [])),
    ),
    includeFake: query.get("includeFake") === "true",
  };
  return serveCsv(request, (actor) => realOrdersCsv(db, actor, input));
}
