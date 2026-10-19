import { receiveWooWebhook, WEBHOOK_MAX_BYTES } from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";

const log = createLogger({ module: "webhooks" });

/**
 * WooCommerce webhook deliveries (SPEC-store-sync "Webhooks"). Not oRPC: the signature is over the
 * raw body. Thin by design: read the bytes, let core decide, answer with its status.
 */
export async function POST(request: Request) {
  const rawBody = await readCapped(request, WEBHOOK_MAX_BYTES);
  const result = rawBody
    ? await receiveWooWebhook(db, { headers: request.headers, rawBody })
    : ({ status: 413, outcome: "tooLarge" } as const);
  if (result.status !== 200) {
    log.warn(
      { outcome: result.outcome, topic: request.headers.get("x-wc-webhook-topic") },
      "webhook refused",
    );
  }
  return Response.json({ outcome: result.outcome }, { status: result.status });
}

/** The body, or null once it passes `max` bytes, without buffering more than that. */
async function readCapped(request: Request, max: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > max) return null;
  if (!request.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
