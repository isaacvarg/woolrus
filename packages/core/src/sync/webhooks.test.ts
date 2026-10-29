import { createHmac } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { StoreError } from "../adapters/woocommerce/errors";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { JOBS_SCHEMA, queues } from "../jobs";
import { processWooWebhook, receiveWooWebhook, WEBHOOK_MAX_BYTES } from "./webhooks";

// The WooCommerce webhook receiver and its job (SPEC-store-sync "Webhooks", SC 7).

const db: Db = testDb();
afterAll(() => db.$disconnect());

const SECRET = "wh_test_secret";

beforeEach(async () => {
  await resetDb(db);
  // The secret comes from the dev/test env fallback, so no encryption key is needed.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WOO_URL", "http://localhost:8090");
  vi.stubEnv("WOO_CONSUMER_KEY", "ck_test");
  vi.stubEnv("WOO_CONSUMER_SECRET", "cs_test");
  vi.stubEnv("WOO_WEBHOOK_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("base64");

function delivery(
  body: object | string,
  {
    topic = "order.created",
    deliveryId = crypto.randomUUID(),
    signature,
  }: { topic?: string; deliveryId?: string; signature?: string | null } = {},
) {
  const rawBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const headers = new Headers({
    "content-type": "application/json",
    "x-wc-webhook-topic": topic,
    "x-wc-webhook-delivery-id": deliveryId,
    "x-wc-webhook-source": "http://localhost:8090/",
  });
  const sig = signature === undefined ? sign(rawBody.toString("utf8")) : signature;
  if (sig !== null) headers.set("x-wc-webhook-signature", sig);
  return { headers, rawBody };
}

/** Jobs for this inbox row (pg-boss's tables aren't reset between tests). */
async function jobsFor(inboundWebhookId: string): Promise<number> {
  const [row] = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND data->>'inboundWebhookId' = $2`,
    queues.ordersWebhook,
    inboundWebhookId,
  );
  return Number(row?.count ?? 0);
}

describe("receiveWooWebhook", () => {
  it("stores a signed order.created and enqueues one job", async () => {
    const result = await receiveWooWebhook(db, delivery({ id: 1234, status: "processing" }));

    expect(result).toEqual({ status: 200, outcome: "accepted" });
    const row = await db.inboundWebhook.findFirstOrThrow();
    expect(row).toMatchObject({
      source: "woocommerce",
      topic: "order.created",
      payload: { id: 1234, status: "processing" },
      processedAt: null,
    });
    expect(await jobsFor(row.id)).toBe(1);
  });

  it("accepts order.updated too", async () => {
    const result = await receiveWooWebhook(db, delivery({ id: 9 }, { topic: "order.updated" }));
    expect(result.outcome).toBe("accepted");
  });

  it("answers a repeated delivery with 200 and no second row or job", async () => {
    const first = delivery({ id: 1234 }, { deliveryId: "d-1" });
    await receiveWooWebhook(db, first);

    const again = await receiveWooWebhook(db, delivery({ id: 1234 }, { deliveryId: "d-1" }));

    expect(again).toEqual({ status: 200, outcome: "duplicate" });
    const rows = await db.inboundWebhook.findMany();
    expect(rows).toHaveLength(1);
    expect(await jobsFor(rows[0]?.id ?? "")).toBe(1);
  });

  it.each([
    ["a wrong signature", sign('{"id":1}', "another secret")],
    ["a missing signature", null],
    ["a malformed signature", "not base64!"],
  ])("refuses %s with 401 and stores nothing", async (_, signature) => {
    const result = await receiveWooWebhook(db, delivery({ id: 1 }, { signature }));

    expect(result).toEqual({ status: 401, outcome: "unauthorized" });
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it("refuses everything with 401 when no secret is configured", async () => {
    vi.stubEnv("WOO_WEBHOOK_SECRET", "");

    const result = await receiveWooWebhook(db, delivery({ id: 1 }));

    expect(result).toEqual({ status: 401, outcome: "unauthorized" });
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it("refuses an unsigned or malformed signature before reading settings", async () => {
    // Settings that can't be read: any request that gets as far as the secret throws.
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    await db.settings.create({ data: { id: 1, wooWebhookSecretEnc: "v1:not:a:ciphertext" } });

    for (const signature of [
      null,
      "",
      "not base64 of a sha256",
      Buffer.alloc(31).toString("base64"),
    ]) {
      expect(await receiveWooWebhook(db, delivery({ id: 1 }, { signature }))).toEqual({
        status: 401,
        outcome: "unauthorized",
      });
    }
    // A well-formed signature does need the secret, so it gets that far (and fails loudly).
    await expect(
      receiveWooWebhook(db, delivery({ id: 1 }, { signature: sign("x") })),
    ).rejects.toThrow();
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it("answers WooCommerce's creation ping with 200 and stores nothing", async () => {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    const result = await receiveWooWebhook(db, {
      headers,
      rawBody: Buffer.from("webhook_id=7"),
    });

    expect(result).toEqual({ status: 200, outcome: "ping" });
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it("ignores other topics with 200 once signed", async () => {
    const result = await receiveWooWebhook(db, delivery({ id: 5 }, { topic: "product.updated" }));

    expect(result).toEqual({ status: 200, outcome: "ignored" });
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it("refuses a body over 1 MB with 413", async () => {
    const big = JSON.stringify({ id: 1, pad: "x".repeat(WEBHOOK_MAX_BYTES) });

    const result = await receiveWooWebhook(db, delivery(big));

    expect(result).toEqual({ status: 413, outcome: "tooLarge" });
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it.each([
    ["not JSON", "{oops"],
    ["no order id", JSON.stringify({ status: "processing" })],
  ])("refuses a signed body with %s with 400", async (_, body) => {
    const result = await receiveWooWebhook(db, delivery(body));

    expect(result).toEqual({ status: 400, outcome: "badRequest" });
    expect(await db.inboundWebhook.count()).toBe(0);
  });

  it("refuses a delivery without a delivery id with 400", async () => {
    const d = delivery({ id: 1 });
    d.headers.delete("x-wc-webhook-delivery-id");

    expect(await receiveWooWebhook(db, d)).toEqual({ status: 400, outcome: "badRequest" });
  });
});

describe("processWooWebhook", () => {
  async function received(payload: object) {
    await receiveWooWebhook(db, delivery(payload));
    return db.inboundWebhook.findFirstOrThrow();
  }

  async function received2(id: number) {
    await receiveWooWebhook(
      db,
      delivery({ id, billing: { first_name: "Ada" } }, { deliveryId: "second" }),
    );
    return db.inboundWebhook.findFirstOrThrow({ where: { deliveryId: "second" } });
  }

  it("a redacted delivery with no anonymized order in the database is marked done and calls the store zero times", async () => {
    const row = await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "redacted-alone",
        topic: "order.updated",
        payload: { redacted: true },
      },
    });
    const store = new FakeStoreAdapter();
    await processWooWebhook(db, store, row.id);
    expect(
      (await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } })).processedAt,
    ).not.toBeNull();
    expect(store.calls).toEqual([]);
  });

  it("a payload with neither an order id nor the redaction marker fails instead of completing", async () => {
    const row = await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "no-id",
        topic: "order.updated",
        payload: { id: "7" },
      },
    });
    await expect(processWooWebhook(db, new FakeStoreAdapter(), row.id)).rejects.toThrow(
      /no order id/,
    );
    expect((await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } })).error).toBe(
      "errors.sync.importFailed",
    );
  });

  it("a redacted delivery keeps its earlier processedAt and clears its error", async () => {
    const earlier = new Date("2026-01-01T00:00:00Z");
    const row = await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "redacted-twice",
        topic: "order.updated",
        payload: { redacted: true },
        processedAt: earlier,
        error: "old",
      },
    });
    await processWooWebhook(db, new FakeStoreAdapter(), row.id, { now: new Date("2026-06-01") });
    expect(await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      processedAt: earlier,
      error: null,
    });
  });

  it("a redacted delivery retried after the purge, with an anonymized order present, is marked done too", async () => {
    // The anonymized order must not be matched through an undefined id.
    const { order } = await createOrder(db, {});
    await db.order.update({ where: { id: order.id }, data: { piiRedactedAt: new Date() } });
    const row = await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "redacted-retry",
        topic: "order.updated",
        payload: { redacted: true },
        receivedAt: new Date("2026-01-01"),
      },
    });
    const store = new FakeStoreAdapter();
    await processWooWebhook(db, store, row.id);
    const after = await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processedAt).not.toBeNull();
    expect(after.error).toBeNull();
    expect(store.calls).toEqual([]);
  });

  it("imports the order from the store, not from the payload, and marks the row processed", async () => {
    const store = new FakeStoreAdapter();
    const woo = store.addOrder({ customer_note: "From the store" });
    const row = await received({ id: woo.id, customer_note: "Forged in the payload" });

    await processWooWebhook(db, store, row.id, { now: store.now() });

    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } });
    expect(order.customerNote).toBe("From the store");
    expect(store.calls.filter((c) => c.method === "getOrder")).toEqual([
      { method: "getOrder", args: [woo.id] },
    ]);
    const after = await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ processedAt: store.now(), error: null });
    expect(await db.syncRun.findFirstOrThrow()).toMatchObject({
      type: "ORDERS_WEBHOOK",
      status: "SUCCEEDED",
    });
  });

  it("marks a delivery for an anonymized order processed and redacts its payload without fetching", async () => {
    const store = new FakeStoreAdapter();
    const woo = store.addOrder();
    const row = await received({ id: woo.id });
    await processWooWebhook(db, store, row.id, { now: store.now() });
    await db.order.update({
      where: { wooOrderId: woo.id },
      data: { customerName: "", piiRedactedAt: new Date() },
    });
    store.calls.length = 0;
    const again = await received2(woo.id);

    await processWooWebhook(db, store, again.id, { now: store.now() });

    expect(store.calls.filter((c) => c.method === "getOrder")).toEqual([]);
    expect(await db.inboundWebhook.findUniqueOrThrow({ where: { id: again.id } })).toMatchObject({
      payload: { redacted: true },
      processedAt: store.now(),
      error: null,
    });
    expect(await db.order.findUniqueOrThrow({ where: { wooOrderId: woo.id } })).toMatchObject({
      customerName: "",
    });
  });

  it("records the error when the import fails", async () => {
    const store = new FakeStoreAdapter();
    const woo = store.addOrder();
    const row = await received({ id: woo.id });
    store.failNext("getOrder", new StoreError("unreachable"));

    await processWooWebhook(db, store, row.id, { now: store.now() });

    const after = await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ processedAt: null, error: "errors.sync.unreachable" });
  });

  it("records notConfigured when the store isn't set up", async () => {
    const row = await received({ id: 1 });

    await processWooWebhook(db, null, row.id);

    const after = await db.inboundWebhook.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ processedAt: null, error: "errors.sync.notConfigured" });
  });
});
