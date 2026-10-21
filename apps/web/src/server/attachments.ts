import { AppError, getAttachment, StorageError } from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { z } from "zod";
import { resolveActor } from "./actor";
import { storage } from "./storage";

const log = createLogger({ module: "attachments" });
const empty = (status: number) => new Response(null, { status });

/**
 * One range, as browsers send for seeking and Safari's audio. Anything else (several ranges, a
 * malformed header) is ignored and the whole file is served, so storage only ever sees one.
 */
function singleRange(header: string | null): string | undefined {
  if (!header) return undefined;
  const value = header.trim();
  return /^bytes=(\d+-\d*|-\d+)$/.test(value) ? value : undefined;
}

/**
 * Streams a note attachment through the app (SPEC-notes "Serving attachments"): storage stays off
 * the network, and `order.read` is checked on every fetch, so no URL grants access by itself.
 */
export async function serveAttachment(
  request: Request,
  id: string,
  variant: "full" | "thumb",
): Promise<Response> {
  const resolved = await resolveActor(request.headers);
  if (!resolved) return empty(401);
  if (!z.uuid().safeParse(id).success) return empty(404);
  try {
    const attachment = await getAttachment(db, resolved.actor, { id, variant });
    const object = await storage().get(attachment.key, singleRange(request.headers.get("range")));
    const headers = new Headers({
      "Content-Type": attachment.contentType,
      // Keys are never reused, so the bytes behind a URL never change.
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Accept-Ranges": "bytes",
      // Defense in depth: voice memos are stored as uploaded, so even if a stored type were ever
      // wrong, the bytes can't run as a page or be embedded by another site.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    // Unknown when storage replied chunked; then the response is chunked too.
    if (object.size !== null) headers.set("Content-Length", String(object.size));
    if (object.contentRange) headers.set("Content-Range", object.contentRange);
    return new Response(object.body, { status: object.contentRange ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.kind === "FORBIDDEN") return empty(403);
      if (error.kind === "NOT_FOUND") return empty(404);
    }
    if (error instanceof StorageError) {
      if (error.kind === "invalidRange") return empty(416);
      // The row exists but its object doesn't: treat it as gone rather than as an outage.
      if (error.kind === "notFound") return empty(404);
    }
    log.error({ err: error, attachmentId: id }, "attachment fetch failed");
    return empty(503);
  }
}
