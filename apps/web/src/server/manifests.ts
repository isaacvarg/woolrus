import { AppError, getManifestPdf, StorageError } from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { z } from "zod";
import { resolveActor } from "./actor";
import { storage } from "./storage";

const log = createLogger({ module: "manifests" });
const empty = (status: number) => new Response(null, { status });

/**
 * Streams a stored manifest PDF through the app (SPEC-shipping "Manifests"): storage stays off the
 * network and `order.ship` is checked on every request, so no URL grants access by itself.
 */
export async function serveManifestPdf(request: Request, param: string): Promise<Response> {
  const resolved = await resolveActor(request.headers);
  if (!resolved) return empty(401);
  const id = param.endsWith(".pdf") ? param.slice(0, -".pdf".length) : param;
  if (!z.uuid().safeParse(id).success) return empty(404);
  try {
    const { key } = await getManifestPdf(db, resolved.actor, { id });
    const object = await storage().get(key);
    const headers = new Headers({
      "Content-Type": "application/pdf",
      // A manifest's bytes never change once stored.
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="manifest-${id}.pdf"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (object.size !== null) headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.kind === "FORBIDDEN") return empty(403);
      if (error.kind === "NOT_FOUND") return empty(404);
    }
    // The row exists but its object doesn't: gone, not an outage.
    if (error instanceof StorageError && error.kind === "notFound") return empty(404);
    log.error({ err: error, manifestId: id }, "manifest fetch failed");
    return empty(503);
  }
}
