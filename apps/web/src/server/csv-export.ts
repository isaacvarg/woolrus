import { AppError, type CsvExport, csvStream, type UserActor } from "@woolrus/core";
import { createLogger } from "@woolrus/logger";
import { resolveActor } from "./actor";

const log = createLogger({ module: "csv-export" });
const empty = (status: number) => new Response(null, { status });

/**
 * Streams a CSV export (FR-REP-04) as a download. `load` checks the permission and reads what it
 * needs before the response starts, so a refusal is a status code, never a broken file.
 */
export async function serveCsv(
  request: Request,
  load: (actor: UserActor) => Promise<CsvExport>,
): Promise<Response> {
  const resolved = await resolveActor(request.headers);
  if (!resolved) return empty(401);
  let csv: CsvExport;
  try {
    csv = await load(resolved.actor);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.kind === "FORBIDDEN") return empty(403);
      if (error.kind === "NOT_FOUND") return empty(404);
      if (error.kind === "BAD_REQUEST") return empty(400);
    }
    log.error({ err: error, path: new URL(request.url).pathname }, "csv export failed");
    return empty(503);
  }
  return new Response(csvStream(csv.header, csv.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csv.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
