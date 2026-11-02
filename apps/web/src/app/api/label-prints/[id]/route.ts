import { AppError, labelPrintPdf, StorageError } from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { z } from "zod";
import { resolveActor } from "@/server/actor";
import { storage } from "@/server/storage";

const log = createLogger({ module: "label-prints" });
const empty = (status: number) => new Response(null, { status });

/**
 * Streams a recorded print (SPEC-shipping "Print"): `label.print` and ownership are checked on
 * every request. Reading never counts a print; `createLabelPrint` already did.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/label-prints/[id]">) {
  const resolved = await resolveActor(request.headers);
  if (!resolved) return empty(401);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return empty(404);
  try {
    const pdf = await labelPrintPdf(db, resolved.actor, storage(), id);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.kind === "FORBIDDEN") return empty(403);
      if (error.kind === "NOT_FOUND") return empty(404);
    }
    // A missing stored object means the label is gone, not that storage is down.
    if (error instanceof StorageError && error.kind === "notFound") return empty(404);
    log.error({ err: error, printId: id }, "label print failed");
    return empty(503);
  }
}
