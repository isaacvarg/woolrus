import { lotLookupCsv } from "@woolrus/core";
import { db } from "@woolrus/db";
import { serveCsv } from "@/server/csv-export";

/** Lot lookup's rows as CSV (SPEC-lumexia "Reads and UI"); `order.read`, like the screen. */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.trim() ?? "";
  if (!code || code.length > 100) return new Response(null, { status: 400 });
  return serveCsv(request, (actor) => lotLookupCsv(db, actor, { code }));
}
