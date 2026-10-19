import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, Prisma } from "@woolrus/db";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { enqueue } from "../enqueue";
import { queues } from "../jobs";
import { getIntegrationConfig } from "../settings/integration";
import { syncOrders } from "./orders";

// WooCommerce webhooks (SPEC-store-sync "Webhooks", FR-SYNC-11). The receiver only proves the
// delivery came from the store and queues it; the job refetches the order from the store, so a
// payload is never trusted as data. Polling stays on as the fallback.

/** WooCommerce order payloads are a few KB; anything this big isn't one. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

const SOURCE = "woocommerce";
const ORDER_TOPICS: ReadonlySet<string> = new Set(["order.created", "order.updated"]);

export type WebhookOutcome =
  | "accepted"
  | "duplicate"
  | "ping"
  | "ignored"
  | "unauthorized"
  | "badRequest"
  | "tooLarge";

export type WebhookResult = { status: 200 | 400 | 401 | 413; outcome: WebhookOutcome };

const result = (status: WebhookResult["status"], outcome: WebhookOutcome): WebhookResult => ({
  status,
  outcome,
});

/** Called by the route with the untouched request body: the signature is over its exact bytes. */
export async function receiveWooWebhook(
  db: Db,
  { headers, rawBody }: { headers: Headers; rawBody: Buffer },
): Promise<WebhookResult> {
  if (rawBody.byteLength > WEBHOOK_MAX_BYTES) return result(413, "tooLarge");

  // Creating a webhook in WooCommerce sends `webhook_id=…` as a form, unsigned, to check the URL.
  const topic = headers.get("x-wc-webhook-topic");
  if (!topic && /^webhook_id=\d+$/.test(rawBody.toString("utf8").trim())) {
    return result(200, "ping");
  }

  const { woocommerce } = await getIntegrationConfig(db);
  const secret = woocommerce?.webhookSecret;
  if (!secret || !signatureMatches(rawBody, headers.get("x-wc-webhook-signature"), secret)) {
    return result(401, "unauthorized");
  }
  if (!topic || !ORDER_TOPICS.has(topic)) return result(200, "ignored");

  const deliveryId = headers.get("x-wc-webhook-delivery-id")?.trim();
  const payload = parsePayload(rawBody);
  if (!deliveryId || !payload) return result(400, "badRequest");

  try {
    await db.$transaction(async (tx) => {
      const row = await tx.inboundWebhook.create({
        data: { source: SOURCE, deliveryId, topic, payload },
      });
      await enqueue(tx, queues.ordersWebhook, { inboundWebhookId: row.id });
    });
  } catch (error) {
    // WooCommerce retries a delivery it thinks failed; the unique key makes that a no-op.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return result(200, "duplicate");
    }
    throw error;
  }
  return result(200, "accepted");
}

/** The `orders.webhook` job: imports the order the delivery names, fetched from the store. */
export async function processWooWebhook(
  db: Db,
  store: StoreAdapter | null,
  inboundWebhookId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<void> {
  const row = await db.inboundWebhook.findUniqueOrThrow({ where: { id: inboundWebhookId } });
  const orderId = (row.payload as { id: number }).id;
  const run = await syncOrders(db, store, {
    type: "ORDERS_WEBHOOK",
    orderIds: [orderId],
    now,
  });
  // Single-order runs never wait on the poll lock, so this is always a finished run.
  if (run.status === "alreadyRunning") throw new Error("unreachable: webhook runs aren't locked");

  const error =
    run.status === "SUCCEEDED"
      ? null
      : await db.syncRun
          .findUniqueOrThrow({
            where: { id: run.runId },
            select: { error: true, errors: { select: { error: true }, take: 1 } },
          })
          .then((r) => r.error ?? r.errors[0]?.error ?? "errors.sync.importFailed");
  await db.inboundWebhook.update({
    where: { id: inboundWebhookId },
    data: error ? { error } : { processedAt: now, error: null },
  });
}

/** `X-WC-Webhook-Signature` is base64 HMAC-SHA256 of the raw body, compared in constant time. */
function signatureMatches(rawBody: Buffer, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.trim(), "base64");
  return given.byteLength === expected.byteLength && timingSafeEqual(given, expected);
}

/** The order payload, as long as it names an order id. Kept as received for the inbox. */
function parsePayload(rawBody: Buffer): (Prisma.InputJsonObject & { id: number }) | null {
  try {
    const payload: unknown = JSON.parse(rawBody.toString("utf8"));
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Number.isInteger((payload as { id?: unknown }).id) &&
      (payload as { id: number }).id > 0
    ) {
      return payload as Prisma.InputJsonObject & { id: number };
    }
  } catch {
    // Not JSON: fall through.
  }
  return null;
}
