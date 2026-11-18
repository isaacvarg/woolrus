import {
  AppError,
  type AppErrorKind,
  type CsvExport,
  csvStream,
  type UserActor,
} from "@woolrus/core";
import { defaultLocale, isLocale, type Locale } from "@woolrus/i18n";
import { createLogger } from "@woolrus/logger";
import { resolveActor } from "./actor";

const log = createLogger({ module: "csv-export" });
const empty = (status: number) => new Response(null, { status });

/** Every refusal core can throw, as the status code the API gives it. */
const STATUS: Record<AppErrorKind, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/**
 * The rows, logging an error thrown while the file streams: the status (200) has gone out by then,
 * so the download just stops, and this line is the only trace of why.
 */
async function* logged(rows: CsvExport["rows"], path: string): CsvExport["rows"] {
  try {
    yield* rows;
  } catch (error) {
    log.error({ err: error, path }, "csv export aborted");
    throw error;
  }
}

/** The query parameters in `names` that are set, as an input object; repeated ones as a list. */
export function queryInput(
  query: URLSearchParams,
  names: readonly string[],
  lists: readonly string[] = [],
): Record<string, string | string[]> {
  return Object.fromEntries([
    ...names.flatMap((name) => (query.get(name) ? [[name, query.get(name) as string]] : [])),
    ...lists.flatMap((name) => (query.getAll(name).length ? [[name, query.getAll(name)]] : [])),
  ]);
}

/**
 * Streams a CSV export (FR-REP-04) as a download. `load` checks the permission and reads what it
 * needs before the response starts, so a refusal is a status code, never a broken file.
 */
export async function serveCsv(
  request: Request,
  load: (actor: UserActor, viewer: { locale: Locale }) => Promise<CsvExport>,
): Promise<Response> {
  const resolved = await resolveActor(request.headers);
  if (!resolved) return empty(401);
  const path = new URL(request.url).pathname;
  let csv: CsvExport;
  try {
    csv = await load(resolved.actor, {
      locale: isLocale(resolved.user.locale) ? resolved.user.locale : defaultLocale,
    });
  } catch (error) {
    if (error instanceof AppError) return empty(STATUS[error.kind]);
    log.error({ err: error, path }, "csv export failed");
    return empty(503);
  }
  return new Response(csvStream(csv.header, logged(csv.rows, path)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csv.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
