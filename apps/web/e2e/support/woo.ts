import { createHmac } from "node:crypto";
import { decryptSecret, encryptionKey } from "@woolrus/core";
import { createDb } from "@woolrus/db";

// The dev WooCommerce (docker/compose.dev.yml, :8090) for dev-stack e2e tests, reached with the
// fixed dev key from .env.example. Never pointed at a real store.

const db = createDb();
const url = process.env.WOO_URL ?? "http://localhost:8090";
const auth = `Basic ${Buffer.from(
  `${process.env.WOO_CONSUMER_KEY ?? ""}:${process.env.WOO_CONSUMER_SECRET ?? ""}`,
).toString("base64")}`;

type WooOrder = { id: number; number: string; date_modified_gmt: string };

async function woo<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${url}/wp-json/wc/v3${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`dev store ${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

const address = (lastName: string, address1: string) => ({
  first_name: "E2E",
  last_name: lastName,
  address_1: address1,
  city: "Austin",
  state: "TX",
  postcode: "78701",
  country: "US",
});

/** A paid (`processing`) order for one of the dev store's simple products. */
export async function createStoreOrder(lastName: string): Promise<WooOrder> {
  const [product] = await woo<{ id: number }[]>("GET", "/products?type=simple&per_page=1");
  if (!product) throw new Error("the dev store has no simple product");
  return woo<WooOrder>("POST", "/orders", {
    status: "processing",
    set_paid: true,
    billing: { ...address(lastName, "1 Main St"), email: "e2e@example.test" },
    shipping: address(lastName, "1 Main St"),
    line_items: [{ product_id: product.id, quantity: 1 }],
  });
}

/** The customer moved: a new shipping street and a note, as an admin would edit it in the store. */
export function editStoreOrderAddress(id: number, lastName: string): Promise<WooOrder> {
  return woo<WooOrder>("PUT", `/orders/${id}`, {
    shipping: address(lastName, "99 New Street"),
    customer_note: `Moved ${new Date().toISOString()}`,
  });
}

/** The webhook secret saved in Settings, decrypted the way the app does. */
export async function savedWebhookSecret(): Promise<string | null> {
  const row = await db.settings.findUnique({ where: { id: 1 } });
  const key = encryptionKey();
  return row?.wooWebhookSecretEnc && key ? decryptSecret(row.wooWebhookSecretEnc, key) : null;
}

/** Headers and body of an `order.updated` delivery, signed like WooCommerce signs them. */
export function signedOrderUpdated(order: WooOrder, secret: string) {
  const body = JSON.stringify(order);
  return {
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-topic": "order.updated",
      "x-wc-webhook-delivery-id": `e2e-${crypto.randomUUID()}`,
      "x-wc-webhook-signature": createHmac("sha256", secret).update(body).digest("base64"),
    },
    data: body,
  };
}

/** Waits for the app to import a store order, by its WooCommerce id. */
export async function importedOrder(wooOrderId: number, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const order = await db.order.findUnique({ where: { wooOrderId } });
    if (order) return order;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`order ${wooOrderId} was not imported within ${timeoutMs} ms`);
}

/** Someone started picking it, so a store edit is flagged rather than applied. */
export function startPicking(orderId: string) {
  return db.order.update({
    where: { id: orderId },
    data: { status: "PICKING", statusChangedAt: new Date(), version: { increment: 1 } },
  });
}

/**
 * Deletes a test order from the dev store and from Woolrus, so neither piles up. Deleting in the
 * store sends no webhook (only order.created / order.updated are registered).
 */
export async function deleteStoreOrder(wooOrderId: number): Promise<void> {
  await woo("DELETE", `/orders/${wooOrderId}?force=true`).catch(() => {});
  await db.order.deleteMany({ where: { wooOrderId } });
}
